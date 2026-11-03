/**
 * The servers themselves — connection details, engagement mode, live roster, and the admin actions taken against players on them.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { resolveServerName } from "../discovery.js";
import { matchMinutesSince, resolveProfile, type ScheduleSpec } from "@app/schedule";
import { badgesForRosterSync } from "../discord-badges.js";
import { describeBanScope, narrowBanScope, parseBanScope, resolveBanScope, type BanScope } from "../ban-scope.js";
import { captureLine, fileRequest } from "../requests.js";
import { postApprovalCard } from "../approval-cards.js";
import type { AppContext } from "../context.js";
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { grantForHeld, heldBy } from "../group-perks.js";
import { can, canAnywhere } from "@app/access";
import { automationDefault, automationEnabled, bankIfHeld, banScopeCovers, gameBanRanOut, memberGameVerdict, perkWritable, planBanReconcile, type MessageRenderer, toPublicServer, SERVER_AUTOMATION_DEFAULT_OFF, SERVER_AUTOMATION_KEYS, type ServerAutomation, type ServerAutomationKey, type ServerConnectionPatch, type ServerRow, type VipRow } from "@app/db";
import { getGame, listGames, playerIdentityOf, resolveTeamSides, rosterPlayerId, V2_CATALOGUE_503 } from "@app/games";
import { MESSAGE_PACE_MS, ObserveModeViolation, RconCommandError, normalizeGameBans, normalizeGameVips, normalizeSession, planVipReconcile } from "@app/rcon-core";
import { appendWelcomeSignature, crconBackupFile, errors, freshLiveReads, LIVE_SHARED_KINDS, liveShareKey } from "@app/shared";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { RconProtocol } from "@app/shared";
import { ACTION_NOTICE_HEADER, ADMIN_ACTIONS, neverShorter, requiredVipComment, FANOUT_ACTIONS, decommissionLocked, describeGameRefusal, HLL_DEFAULT_ADMIN_GROUPS, computeGrantExpiration, configFieldsFor, connectGameClient, extractConfigValue, gameClientFor, lastGameWriteAt, logger, parseAdminGroups, requirePrincipal, route, sendForbidden, serverRoute, parseHours, signedText, signerFor, tempbanMaxHours, tempbanRefusal, unbanTargetMissing, unbanTargetMissingIn, unbanStillListed, UnbanTargetMissing, crossGameIdError, renderActionText, type Route } from "./kit.js";
import { pauseMs, rendererFor, sendPlayerMessage } from "../render-text.js";

/** How an automation audit line names each reconciler's fix switch. */
const AUTOMATION_FIX_WORDS: Partial<Record<ServerAutomationKey, string>> = {
  banSyncApply: "ban list fixes",
  vipSyncApply: "VIP list fixes",
};

/**
 * The live payload every panel viewer polls, shared for a few seconds per server. See the /live
 * route for why: the cache collapses N watching admins to one RCON session per interval, and an
 * entry holds the in-flight promise so concurrent viewers coalesce instead of racing connections.
 */
const LIVE_CACHE_MS = 4000;
const liveCache = new Map<string, { at: number; read: Promise<unknown> }>();

/** One real RCON read of a server's live state, registered in the cache before it resolves. */
/**
 * Record an unban against the DECISIONS, honouring how far it actually reached.
 *
 * `liftedServerIds` is the servers where the game accepted the unban — successes only, because a
 * server that refused still enforces the ban and the record must keep saying so. Each active
 * decision of this kind is then narrowed by exactly those servers: untouched rules stay, rules
 * lifted everywhere they cover are stamped lifted, and a partial lift shrinks the rule to the
 * servers still banned. This used to be liftAllFor — one unban on one server marked a
 * community-wide ban lifted everywhere, the Bans page said it was over while the game still
 * enforced it, and an ARMED reconciler would have read those live bans as strays and removed
 * them, finishing an unban nobody asked for.
 */
async function recordUnban(
  ctx: AppContext,
  args: { game: string; playerId: string; kind: "temp" | "perma"; liftedServerIds: string[]; liftedByName: string },
): Promise<void> {
  if (!args.liftedServerIds.length) return;
  const servers = await ctx.repo.servers.list();
  const decisions = (await ctx.repo.playerBans.list({ playerId: args.playerId, activeOnly: true }))
    .filter((b) => b.kind === args.kind && b.game === args.game);
  for (const d of decisions) {
    const r = narrowBanScope(d.scope as BanScope, args.liftedServerIds, servers, args.game);
    if (r.outcome === "lift") await ctx.repo.playerBans.lift(d.id, args.liftedByName);
    else if (r.outcome === "narrow") await ctx.repo.playerBans.setScope(d.id, r.scope);
  }
}

/** A server's live state as one read of the game returns it. */
interface LiveRead { rawSession: unknown; players: unknown; mapRotation: unknown }

/** The live state read from the game itself, over a connection of our own. */
async function readLiveFromGame(server: ServerRow): Promise<LiveRead> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    const [rawSession, players, mapRotation] = await Promise.all([
      client.readState("session"),
      client.readState("players"),
      client.readState("maprotation").catch(() => null), // tolerate protocols that don't expose it
    ]);
    return { rawSession, players, mapRotation };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * The worker's latest reads of the server (@app/shared live-share), when all three are fresh enough
 * to show. While a round runs the worker reads the session every 2 seconds and the roster about
 * every 10, over the connections it holds; reading them again here cost the game a new connection
 * and login on every refresh of every viewer. Reads taken before this process last changed
 * something on the server are not used: the page reloads straight after a kick or a team switch,
 * and must show it.
 */
async function sharedLiveRead(ctx: AppContext, id: string): Promise<LiveRead | null> {
  const [session, players, maprotation] = await Promise.all(LIVE_SHARED_KINDS.map((kind) => ctx.bus.recall(liveShareKey(id, kind))));
  const fresh = freshLiveReads({ session, players, maprotation }, Date.now(), lastGameWriteAt(id));
  return fresh && { rawSession: fresh.session, players: fresh.players, mapRotation: fresh.maprotation };
}

/** The actions that only mean anything while the player is CURRENTLY on the server. */
function readLiveOnce(ctx: AppContext, id: string, server: ServerRow): Promise<unknown> {
  const read = (async () => {
    const { rawSession, players, mapRotation } = (await sharedLiveRead(ctx, id)) ?? (await readLiveFromGame(server));
    // Passively record identity history (names + clan tags) for players new to the store — the
    // rest are the worker's to keep (see below). Recording to OUR db is not an RCON write, so it's
    // allowed on observe servers. Best-effort: never fail the read.
    const roster = Array.isArray(players) ? players : Array.isArray((players as { players?: unknown[] })?.players) ? (players as { players: unknown[] }).players : [];
    const now = new Date().toISOString();
    // Resolve each roster player to our db id, so we can attach flags + a stable profile link below.
    const dbIdByPlatform = new Map<string, string>();
    // Which of the payload's fields is the durable identity is the GAME's decision, not
    // ours — HLL reports the platform id directly, while HLL: Vietnam keys everyone by a
    // per-game EOS id and carries the Steam64 beside it. playerIdentityOf routes through the
    // module so a new game fixes this by implementing `identity`, not by editing core.
    const mod = getGame(server.game);
    try {
      const withIdentity = (roster as Record<string, unknown>[])
        .map((pl) => ({ pl, who: playerIdentityOf(mod, pl) }))
        .filter((x): x is { pl: Record<string, unknown>; who: NonNullable<ReturnType<typeof playerIdentityOf>> } => !!x.who);
      const seen = withIdentity.map(({ pl, who }) => ({
        game: server.game,
        platform: who.platform,
        platformId: who.platformId,
        name: String(pl?.name ?? ""),
        clanTag: pl?.clanTag !== undefined ? String(pl.clanTag) : undefined,
        // Roster reads are the only place a level is ever visible; keeping it here is what
        // lets the enforcer (which acts from events, with no roster in hand) gate on it.
        level: Number.isFinite(Number(pl?.level)) ? Number(pl.level) : undefined,
        ts: now,
      }));
      // Players already on record are not saved again. The worker's roster sample keeps their
      // names, levels, last-seen times and identity links current once a minute; saving everyone
      // on every refresh (each viewer, every 15 seconds) was most of the database's writes during
      // a round, and counted each refresh as another sighting of every name. Someone the store has
      // never seen is added here, so every row links to a profile.
      for (const row of await ctx.repo.players.findByPlatformIds(seen.map((p) => p.platformId))) dbIdByPlatform.set(row.platformId, row.id);
      const added = new Set<string>();
      const unknown = seen.filter((p) => !dbIdByPlatform.has(p.platformId));
      if (unknown.length) {
        for (const row of await ctx.repo.players.upsertMany(unknown)) { dbIdByPlatform.set(row.platformId, row.id); added.add(row.platformId); }
      }
      // Cross-store identity goes into the generic external-links store, not a players column.
      // Only the players just added that actually carry one, which is normally none of them.
      await Promise.all(withIdentity
        .filter(({ who }) => added.has(who.platformId))
        .flatMap(({ who }) => (who.links ?? []).map((link) => ({ platformId: who.platformId, link })))
        .map(({ platformId, link }) => {
          const id = dbIdByPlatform.get(platformId);
          return id ? ctx.repo.externalLinks.set(id, link.provider, link.externalId) : undefined;
        }));
    } catch { /* best-effort identity capture: never fail the read over it */ }
    // Attach watch/VIP flags to the on-screen roster (⭐/👁 marks + the context strip). flagged is a
    // small set, so this is one query, not one per player.
    // One canonical session shape, whatever the protocol's key style. Binary v2 mangles acronyms
    // (`VIPQueueCount` arrives as `vIPQueueCount`) and the CRCON bridge answers snake_case, so a
    // reader that picked one spelling silently rendered the others as zero.
    const session = normalizeSession(rawSession);
    const flagged = await ctx.repo.playerFlags.listWatched();
    const flagByDbId = new Map(flagged.map((f) => [f.playerId, f]));
    // Real VIP is a GRANT on this server, not the cosmetic profile marker. The roster used to
    // report the marker as `vip`, so the ★ and the "VIPs: n" count were both counting an
    // annotation almost nobody sets — a server full of VIPs read as zero. Paused grants are
    // excluded: the whole point of a VIP timeout is that they do not have VIP right now.
    const nowMs = Date.now();
    const vipIds = new Set(
      (await ctx.repo.vips.list(server.id))
        .filter((v) => !(v.pausedUntil && Date.parse(v.pausedUntil) > nowMs))
        .filter((v) => !v.expiration || Date.parse(v.expiration) > nowMs)
        .map((v) => v.playerId),
    );
    // Console admin on THIS server (live grants only) — the 🎥 mark, same shape as the VIP set:
    // a current grant, not a memory of one.
    const adminIds = new Set(
      (await ctx.repo.consoleAdmins.list(server.id).catch(() => []))
        .filter((a) => !a.expiration || Date.parse(a.expiration) > nowMs)
        .map((a) => a.playerId),
    );
    // Community role badges — answered from the cache only, so a hundred-player roster never
    // waits on Discord; unknowns are queued and wear their badges on a later poll.
    const { roleBadges } = await ctx.repo.appConfig.get();
    const badgesByDbId = badgesForRosterSync(ctx.repo, roleBadges, [...dbIdByPlatform.values()]);
    // Resolve each raw team number to a faction HERE, with the session's own headcounts as
    // evidence — the static descriptor guess alone has mislabeled whole lobbies (both teams
    // shown as Axis on console builds). The panel and every downstream consumer use this
    // attached `side`, so the decision is made once, in one tested place.
    const teamCounts = new Map<number, number>();
    for (const pl of roster as Record<string, unknown>[]) {
      const t = Number(pl?.team);
      if (Number.isFinite(t)) teamCounts.set(t, (teamCounts.get(t) ?? 0) + 1);
    }
    const sideByTeam = resolveTeamSides(mod?.descriptor.sides ?? [], teamCounts, session);
    // Session start + visit history for the TIME/VISITS columns (CRCON parity): two queries per
    // 15s poll for the whole roster, keyed by our db id. Best-effort — a hiccup in either read
    // must never take the live view down, it just leaves the columns blank for one refresh.
    let openedAt = new Map<string, string>();
    let visitsByDbId = new Map<string, { visits: number; playtimeSec: number }>();
    try {
      openedAt = await ctx.repo.sessions.openOnServer(server.id);
      visitsByDbId = await ctx.repo.stats.visitsFor([...dbIdByPlatform.values()], server.id);
    } catch { /* columns render blank for this refresh */ }
    // Roster entries the identity rule could NOT key are still people on the server — they
    // render in the table — but nothing durable can attach to them: no player row, no session,
    // no kills, no VIP, no analytics. That is a whole platform's population going missing the
    // day the game changes a field, so the payload says it out loud: a count, and the field
    // names (never values) of one such entry, which is exactly what fixing the parser needs.
    const unidentified = (roster as Record<string, unknown>[]).filter((pl) => !playerIdentityOf(mod, pl));
    const untrackedSampleKeys = unidentified.length ? Object.keys(unidentified[0]!).sort() : [];
    const enriched = (roster as Record<string, unknown>[]).map((pl) => {
      // Same identity resolution as the upsert above — the db row is keyed on the DURABLE id,
      // which for some games is not the id the roster reports (see playerIdentityOf).
      const who = playerIdentityOf(mod, pl);
      const dbId = dbIdByPlatform.get(who?.platformId ?? "");
      const f = dbId ? flagByDbId.get(dbId) : undefined;
      const t = Number(pl?.team);
      // watchReason/watchBy ride along so the 👁 mark can say WHY on hover — the flagged rows
      // already carry them, this costs nothing extra.
      const platformId = rosterPlayerId(pl);
      return {
        ...pl, playerDbId: dbId ?? null,
        untracked: !who,
        watch: f?.watchlist ?? false, watchReason: f?.watchlist ? f.watchReason : null, watchBy: f?.watchlist ? f.watchBy : null,
        // A live grant, and the only VIP there is — the manual marker that used to ride
        // alongside is gone, so the roster star can no longer disagree with the game.
        vip: vipIds.has(platformId),
        consoleAdmin: adminIds.has(platformId),
        badges: (dbId && badgesByDbId.get(dbId)) || [],
        side: Number.isFinite(t) ? sideByTeam.get(t) ?? null : null,
        // TIME/VISITS: when this session opened (from our ingest's connect pairing) and how many
        // recorded visits they have on THIS server. Nulls when we have no record — a fresh
        // install or a player whose connect predates ingest — and the panel shows a dash.
        sessionStartedAt: (dbId && openedAt.get(dbId)) || null,
        visits: dbId ? visitsByDbId.get(dbId)?.visits ?? null : null,
      };
    });
    return {
      engagementMode: server.engagementMode, session, players: enriched, mapRotation,
      untrackedCount: unidentified.length, untrackedSampleKeys,
    };
  })();
  liveCache.set(id, { at: Date.now(), read });
  return read;
}

/** A roster without the reasons behind its 👁 marks, for a reader the watchlist permission doesn't
 *  cover. Copies: the payload it is given is the one every viewer of the server shares. */
function withoutWatchReasons(live: unknown): unknown {
  const l = live as { players?: unknown };
  if (!Array.isArray(l?.players)) return live;
  return { ...l, players: (l.players as Record<string, unknown>[]).map((pl) => ({ ...pl, watchReason: null, watchBy: null })) };
}

export const serversRoutes: Route[] = [
  // The server list respects per-server scoping: you only see servers you can view. User-admins
  // see all of them regardless (the permission editor needs the names for its scope tabs).
  route("GET", "/api/servers", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Number BEFORE filtering. `servers.list()` is ordered by created_at, so the index here is
    // "the Nth server this community added" — a fact about the community, identical for everyone.
    // Numbering after the filter made it a fact about the READER instead: somebody granted access
    // to the third server alone got a one-server list and was shown "Server 1", which is the
    // wrong answer to "which server am I looking at" and disagrees with what their colleagues see.
    // Retirement follows the same rule: numbering runs over EVERY server ever added (retired
    // included), so retiring server 2 does not silently renumber server 3 in everyone's head —
    // then retired rows are dropped unless the caller (the Connections tab) asked for them.
    const includeRetired = new URL(req.url ?? "", "http://x").searchParams.get("includeRetired") === "1";
    // Stage 2 is per-READER: a decommissioned server exists only for the setup account — the
    // install's first login — no matter what grants anyone else holds or what they ask for in
    // the query string. Numbering still runs over the full list first, so nothing renumbers.
    // A role preview is answered as the role, and nobody in a role is the setup account.
    const isSetupUser = !p.preview && p.user.id === await ctx.repo.users.firstUserId();
    const all = (await ctx.repo.servers.list({ includeRetired: true }))
      .map((s, i) => ({ ...toPublicServer(s), no: i + 1 }))
      .filter((s) => isSetupUser || !s.decommissionedAt)
      .filter((s) => includeRetired || !s.retiredAt);
    const servers = canAnywhere(p.grants, "admin.users", "read")
      ? all
      : all.filter((s) => can(p.grants, "server.view", "read", { serverId: s.id }));
    // The shareable base for public stats links. When a dedicated hostname is configured the
    // Connections card must show THAT address, not the panel's — handing staff a link that
    // carries the admin hostname is exactly what the dedicated host exists to prevent.
    sendJson(res, 200, { servers, isSetupUser, publicStatsOrigin: ctx.config.publicStatsOrigin ?? null });
  }),

  route("POST", "/api/servers", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Deliberately scope-blind, and the only one left: there is no server yet to scope to, so
    // creating one is a community-level act that a single-server grant should NOT confer.
    if (!can(p.grants, "server.add", "write")) return sendForbidden(res, "server.add", "write");
    const body = await readJsonBody(req);
    const host = str(body.host).trim();
    const port = Number(body.port);
    const password = str(body.password);
    if (!host || !port || !password) return sendError(res, 400, "host, port and password are required");
    // A truthiness check catches "" and "abc" (NaN) and nothing else, so 99999, -5 and 1.5 were all
    // stored as ports. The connection then fails at dial time with a message about the socket
    // rather than about the number that was typed.
    if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "port must be a whole number between 1 and 65535");
    const protocol = (str(body.protocol) as RconProtocol) || "binary-v2";
    const crconBaseUrl = str(body.crconBaseUrl).trim() || null;
    // crcon-bridge reads through an existing CRCON, so it needs that instance's URL (and the
    // `password` field carries the CRCON API key).
    if (protocol === "crcon-bridge" && !crconBaseUrl) return sendError(res, 400, "crcon-bridge requires crconBaseUrl (the existing CRCON instance URL)");
    // Which game this server runs — must have a registered game module (command table + parser),
    // and the chosen protocol must be one that game supports.
    const game = str(body.game).trim().toLowerCase() || "hll";
    const mod = getGame(game);
    if (!mod) return sendError(res, 400, `unknown game '${game}'. Known: ${listGames().map((g) => g.id).join(", ")}`);
    if (!mod.protocols.some((pr) => pr.id === protocol)) return sendError(res, 400, `protocol '${protocol}' is not supported by ${mod.label}. Supported: ${mod.protocols.map((pr) => pr.id).join(", ")}`);
    const server = await ctx.repo.servers.create({
      name: boundedText(body.name, TEXT_MAX.name, "name") || `${host}:${port}`,
      game,
      host,
      port,
      password,
      protocol,
      headerMode: str(body.headerMode) === "legacy" ? "legacy" : "magic",
      crconBaseUrl,
      // engagement mode intentionally NOT settable here — defaults to observe (safe).
    });
    // Prefer the live name from RCON (providers like GTX rename over RCON). Best-effort: if
    // the server is unreachable the typed/fallback name stands and we don't fail the add.
    const live = await resolveServerName(ctx.repo, server);
    const stored = live ? (await ctx.repo.servers.findById(server.id)) ?? server : server;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.add",
      targetType: "server", targetId: stored.id, targetName: stored.name, serverId: stored.id,
      // No credentials in the entry — the trail is read by more people than may see them.
      summary: `connected ${stored.name} (${host}:${port}, ${protocol})`,
      data: { host, port, protocol, game },
    });
    sendJson(res, 201, { server: toPublicServer(stored) });
  }),

  /**
   * Change how the panel reaches an existing server — address, port, credential, protocol.
   *
   * This did not exist, and its absence was a dead end with no way out of it. A server's password
   * could be set once, at add time. When a host rotates the RCON credential (they do), the panel
   * went on dialling with the old one: every write to that server failed with "(401) Unable to
   * perform request. Missing authentication credentials", bans stopped applying, unbans stopped
   * lifting, and the ban reconciler quietly reported a growing pile of work it could not do. The
   * env is not the escape hatch it looks like — discovery treats it as a seed and will not
   * overwrite a server it already knows — so the correct new password could sit in the
   * environment while the app kept using the stale one. The only remaining fix was editing the
   * database by hand.
   *
   * Scoped: this names an existing server, so "you look after that server's connection" is a real
   * per-server grant. Adding a NEW server stays a separate, community-level permission.
   */
  /**
   * Stage 1 of retire → decommission → delete. Retiring touches NOTHING but the stamp: every row
   * the server ever produced — careers, matches, events, VIP history, bans — stays exactly where
   * it is. What changes is visibility: the default server list drops the row, so every picker,
   * worker loop, Discord module and public page loses it at once, and only the Connections tab
   * (which asks for retired rows) still shows it, with a bring-back button. This stage is open
   * to any server.manage holder and freely reversible — the later stages are not theirs to take.
   */
  route("POST", "/api/servers/:id/retire", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "server.manage", "write", { serverId: params.id })) return sendForbidden(res, "server.manage", "write");
    if (await decommissionLocked(ctx, p, params.id!)) return sendError(res, 404, "server not found");
    const server = await ctx.repo.servers.setRetired(params.id!, true);
    if (!server) return sendError(res, 404, "server not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.retire",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `retired ${server.name} — hidden everywhere but Connections; every record kept`,
      data: { retiredAt: server.retiredAt },
    });
    sendJson(res, 200, { server: toPublicServer(server) });
  }),

  /**
   * Stage 2 — decommission. From here on the keys belong to ONE person: the install's first
   * created login, "the account that set HellRCON up". Not a permission — permissions can be
   * handed out, and whoever holds this stage holds the road to the final delete. Decommissioning
   * is still only a visibility stamp: every record stays put and retrievable, but the server
   * vanishes from every OTHER account's Connections tab (the server list filters per reader).
   * Requires the server to already be retired, and is reversible back to plain retired.
   */
  route("POST", "/api/servers/:id/decommission", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (p.user.id !== await ctx.repo.users.firstUserId()) {
      return sendError(res, 403, "only the setup account — the first login this install created — can decommission a server. No permission grants this");
    }
    const existing = await ctx.repo.servers.findById(params.id!);
    if (!existing) return sendError(res, 404, "server not found");
    if (!existing.retiredAt) return sendError(res, 409, "retire the server first — decommissioning is stage two of retire → decommission → delete");
    const server = (await ctx.repo.servers.setDecommissioned(params.id!, true))!;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.decommission",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `decommissioned ${server.name} — now visible ONLY to the setup account; every record kept and retrievable`,
      data: { decommissionedAt: server.decommissionedAt },
    });
    sendJson(res, 200, { server: toPublicServer(server) });
  }),

  route("POST", "/api/servers/:id/recommission", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (p.user.id !== await ctx.repo.users.firstUserId()) {
      return sendError(res, 403, "only the setup account — the first login this install created — can recommission a server. No permission grants this");
    }
    const server = await ctx.repo.servers.setDecommissioned(params.id!, false);
    if (!server) return sendError(res, 404, "server not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.recommission",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `recommissioned ${server.name} — back to retired, visible on everyone's Connections tab again`, data: {},
    });
    sendJson(res, 200, { server: toPublicServer(server) });
  }),

  /**
   * Stage 3 — the point of no return, reachable only through stages 1 AND 2, and only by the
   * setup account (grants are deliberately not consulted: "anyone with a permission" must never
   * hold this key). Deletion takes what belonged to the SERVER: matches and reports, non-
   * moderation events, sessions, VIPs including paid ones, bans, configs, scoped rules and
   * triggers, and the stored CRCON archive file. What it does NOT take is user history — careers
   * earned there and the moderation record (kicks, bans, punishes, admin messages, camera
   * watches) survive even this, alongside player identities, notes, flags, watchlists, the
   * economy, and the audit trail — including this deletion's own receipt.
   * (No typed confirmation, deliberately: see the purge route's note — the gate is WHO you are,
   * and the panel asks in plain words before calling.)
   */
  route("DELETE", "/api/servers/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (p.user.id !== await ctx.repo.users.firstUserId()) {
      return sendError(res, 403, "only the setup account — the first login this install created — can delete a server. No permission grants this");
    }
    const server = await ctx.repo.servers.findById(params.id!);
    if (!server) return sendError(res, 404, "server not found");
    if (!server.retiredAt) return sendError(res, 409, "retire the server first — deletion is the last step of retire → decommission → delete, so a live server can never be erased in one motion");
    if (!server.decommissionedAt) return sendError(res, 409, "decommission the server first — deletion is the last step of retire → decommission → delete");
    if (ctx.crconTransforms.get(server.id)?.status === "running") return sendError(res, 409, "an Apply run is reading this server's archive — wait for it to finish");

    // History first (events/sessions/careers carry no FK) with the user-history carve-out, then
    // the row (FKs cascade the rest), then the archive file on disk — the one artifact the
    // database cannot take with it.
    const counts = await ctx.repo.crconSnapshot.purgeServerData(server.id, { keepUserHistory: true });
    await ctx.repo.servers.remove(server.id);
    const file = crconBackupFile(server.id);
    if (existsSync(file)) await unlink(file).catch(() => {});

    logger.warn("server permanently deleted", { serverId: server.id, server: server.name, by: p.name, ...counts });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.delete",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `PERMANENTLY deleted decommissioned server ${server.name}: ${counts.events.toLocaleString()} event(s), ${counts.matches.toLocaleString()} match(es), ${counts.sessions.toLocaleString()} session(s), ${counts.bans} ban(s), ${counts.vips} VIP(s), plus its configs, scoped rules/triggers and archive. User history is forever: careers, the moderation record, player identities, community records and the audit trail survive`,
      data: { ...counts, retiredAt: server.retiredAt, decommissionedAt: server.decommissionedAt },
    });
    sendJson(res, 200, { deleted: true, counts });
  }),

  route("POST", "/api/servers/:id/unretire", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "server.manage", "write", { serverId: params.id })) return sendForbidden(res, "server.manage", "write");
    const existing = await ctx.repo.servers.findById(params.id!);
    if (!existing) return sendError(res, 404, "server not found");
    // For anyone but the setup account a decommissioned server does not exist — a 409 here would
    // CONFIRM it does, so they get the same 404 as a wrong id.
    if (await decommissionLocked(ctx, p, existing)) return sendError(res, 404, "server not found");
    // The ladder unwinds in order too: even the setup account recommissions before bringing it
    // back live — unretiring straight out of stage 2 would skip the deliberate step in between.
    if (existing.decommissionedAt) return sendError(res, 409, "this server is decommissioned — recommission it before bringing it back");
    const server = (await ctx.repo.servers.setRetired(params.id!, false))!;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.unretire",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `brought ${server.name} back from retirement`, data: {},
    });
    sendJson(res, 200, { server: toPublicServer(server) });
  }),

  route("PUT", "/api/servers/:id/connection", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "server.manage", "write", { serverId: params.id })) return sendForbidden(res, "server.manage", "write");
    const server = await ctx.repo.servers.findById(params.id!);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);

    const patch: ServerConnectionPatch = {};
    if (body.host !== undefined) {
      const host = str(body.host).trim();
      if (!host) return sendError(res, 400, "host cannot be empty");
      patch.host = host;
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "port must be a whole number between 1 and 65535");
      patch.port = port;
    }
    // Absent means "leave it alone" — the editor never receives the stored secret, so it cannot
    // send one back. An explicitly EMPTY password is refused rather than stored: a blank
    // credential authenticates against nothing and would look like a rotation that worked.
    if (body.password !== undefined) {
      const password = str(body.password);
      if (!password) return sendError(res, 400, "password cannot be empty — omit the field to keep the current one");
      patch.password = password;
    }
    const protocol = (str(body.protocol) as RconProtocol) || server.protocol;
    if (body.protocol !== undefined) {
      const mod = getGame(server.game);
      if (!mod?.protocols.some((pr) => pr.id === protocol)) {
        return sendError(res, 400, `protocol '${protocol}' is not supported by ${mod?.label ?? server.game}. Supported: ${(mod?.protocols ?? []).map((pr) => pr.id).join(", ")}`);
      }
      patch.protocol = protocol;
    }
    if (body.headerMode !== undefined) patch.headerMode = str(body.headerMode) === "legacy" ? "legacy" : "magic";
    if (body.crconBaseUrl !== undefined) patch.crconBaseUrl = str(body.crconBaseUrl).trim() || null;
    // Same pairing rule the add route enforces, checked against the RESULT rather than the input:
    // switching to the bridge without a URL, or clearing the URL while on the bridge, are the same
    // broken end state arrived at from two directions.
    const endProtocol = patch.protocol ?? server.protocol;
    const endUrl = patch.crconBaseUrl !== undefined ? patch.crconBaseUrl : server.crconBaseUrl;
    if (endProtocol === "crcon-bridge" && !endUrl) return sendError(res, 400, "crcon-bridge requires crconBaseUrl (the existing CRCON instance URL)");

    // An empty body is a mistake, not a no-op: it would write an audit row saying nothing changed.
    if (!Object.keys(patch).length) return sendError(res, 400, "nothing to update — send at least one of host, port, password, protocol, headerMode, crconBaseUrl");

    const updated = await ctx.repo.servers.updateConnection(params.id!, patch);
    if (!updated) return sendError(res, 404, "server not found");
    // What changed, never what it changed TO for the secret. The trail is read by more people than
    // may hold the credential — that is the whole reason the add route redacts it too.
    const changed = Object.keys(patch).map((k) => (k === "password" ? "password" : k));
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.connection",
      targetType: "server", targetId: updated.id, targetName: updated.name, serverId: updated.id,
      summary: `updated the connection for ${updated.name} (${changed.join(", ") || "no change"}) — now ${updated.host}:${updated.port}, ${updated.protocol}`,
      data: { changed, host: updated.host, port: updated.port, protocol: updated.protocol },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  // Re-pull a server's display name from RCON on demand.
  route("POST", "/api/servers/:id/refresh-name", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    // Updates the STORED server name — that's server management, not viewing. Checked AGAINST THIS
    // SERVER: the id is right there in the path, and without passing it a grant scoped to this
    // server cannot satisfy the check at all, so only a global grant could rename anything.
    if (!can(p.grants, "server.manage", "write", { serverId: id })) return sendForbidden(res, "server.manage", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const live = await resolveServerName(ctx.repo, server);
    const updated = (await ctx.repo.servers.findById(id)) ?? server;
    // Only when it actually changed: this button gets pressed speculatively, and an entry per
    // press would bury the renames that matter under the ones that did nothing.
    if (updated.gameName !== server.gameName) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "server.rename",
        targetType: "server", targetId: id, targetName: updated.name, serverId: id,
        summary: `re-read the server name over RCON: "${server.gameName}" is now "${updated.gameName}"`,
        data: { from: server.gameName, to: updated.gameName },
      });
    }
    sendJson(res, 200, { server: toPublicServer(updated), resolved: Boolean(live), name: live });
  }),

  /**
   * Correct which game a server runs (and, with it, the protocol used to reach it).
   *
   * The game decides how EVERY read of this server is interpreted — roles, sides, weapon buckets,
   * map vocabulary, and the rule that turns a roster entry into a player identity. It could be set
   * wrong at creation and was then permanent: env discovery seeded every server as `hll` with no
   * way to say otherwise, and because HLL: Vietnam speaks HLL's RCON wire for wire, a mislabelled
   * Vietnam server connects happily and is quietly misread. This is the correction.
   *
   * It is a RELABEL, not a conversion: rows already written under the old game id (ban records,
   * map display-name overrides) keep that id, so this is meant for a server labelled wrong from
   * the start rather than for repointing a live one at a different game. The response says how
   * much such data exists so the panel can warn before anyone presses it.
   */
  route("POST", "/api/servers/:id/game", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    // Same capability as adding a server, checked against THIS server — the id is in the path, so
    // a grant scoped to this one server satisfies it and a holder elsewhere does not.
    if (!can(p.grants, "server.manage", "write", { serverId: id })) return sendForbidden(res, "server.manage", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const game = str(body.game).trim().toLowerCase();
    const mod = getGame(game);
    if (!mod) return sendError(res, 400, `unknown game '${game}'. Known: ${listGames().map((g) => g.id).join(", ")}`);
    // Keep the current protocol when the new game speaks it, otherwise fall to that game's first.
    // An explicit protocol in the body wins, and is validated against the game either way.
    const protocol = (str(body.protocol).trim().toLowerCase() || (mod.protocols.some((pr) => pr.id === server.protocol) ? server.protocol : mod.protocols[0]?.id)) as RconProtocol;
    if (!mod.protocols.some((pr) => pr.id === protocol)) {
      return sendError(res, 400, `protocol '${protocol}' is not supported by ${mod.label}. Supported: ${mod.protocols.map((pr) => pr.id).join(", ")}`);
    }
    if (protocol === "crcon-bridge" && !server.crconBaseUrl) {
      return sendError(res, 400, "crcon-bridge needs a CRCON base URL, which this server does not have");
    }
    if (server.game === game && server.protocol === protocol) {
      return sendJson(res, 200, { server: toPublicServer(server), changed: false });
    }
    // Captured BEFORE setGame: the in-memory store's findById hands back a live reference, so the
    // update mutates `server` itself and everything below that says "the old game" would silently
    // read the new one (the clear would never fire, and the audit's "was …" would name the game
    // it just became).
    const from = { game: server.game, protocol: server.protocol };
    const updated = await ctx.repo.servers.setGame(id, game, protocol);
    if (!updated) return sendError(res, 404, "server not found");
    // The seeding config's role numbers, weapon classes, weapon names and commander abilities are
    // the OLD game's vocabulary — on the new game they mean different things (role 1 is HLL's
    // Assault and nothing at all in Vietnam) or nothing, and the stale ids would both enforce a
    // policy nobody wrote and wedge the Seeding page (every save re-validates the whole config
    // against the new game's tables, refusing ids the UI no longer even renders). Cleared here,
    // where the vocabulary change happens; the free-text weapon extras are plain substrings and
    // survive, as do all thresholds, messages and reward settings.
    let seedingCleared = false;
    if (from.game !== game) {
      const seedCfg = await ctx.repo.seeding.getConfig(id);
      if (seedCfg && (seedCfg.disallowedRoles.length || seedCfg.disallowedWeaponClasses.length
        || seedCfg.disallowedWeaponNames.length || seedCfg.disallowedCommanderAbilities.length)) {
        await ctx.repo.seeding.upsertConfig(id, {
          disallowedRoles: [], disallowedWeaponClasses: [], disallowedWeaponNames: [], disallowedCommanderAbilities: [],
        });
        seedingCleared = true;
      }
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.game",
      targetType: "server", targetId: id, targetName: updated.name, serverId: id,
      summary: `set ${updated.name} to ${mod.label} (${protocol}) — was ${from.game} (${from.protocol})`
        + (seedingCleared ? "; cleared the seeding role/weapon restrictions (they were the old game's vocabulary)" : ""),
      data: { from, to: { game, protocol }, seedingCleared },
    });
    sendJson(res, 200, { server: toPublicServer(updated), changed: true });
  }),

  // Per-automation switches: which of this app's automations may act on this server. The staged
  // path off CRCON — a server can be active with only the map vote enabled while CRCON still owns
  // VIP, broadcasts and enforcement. Same capability as the engagement switch: both decide what
  // the app is allowed to do to the game.
  route("PUT", "/api/servers/:id/automation", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.engagement", "write", { serverId: id })) return sendForbidden(res, "server.engagement", "write");
    if (await decommissionLocked(ctx, p, id)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    if (typeof body.automation !== "object" || body.automation === null || Array.isArray(body.automation)) {
      return sendError(res, 400, "automation must be an object of switches");
    }
    for (const key of Object.keys(body.automation as object)) {
      if (!(SERVER_AUTOMATION_KEYS as readonly string[]).includes(key)) return sendError(res, 400, `unknown automation switch '${key}'`);
    }
    // Exceptions-only storage: only entries that differ from the switch's default are kept, so the
    // defaults are {} and old rows never need rewriting when a new automation is added. A key the
    // body leaves out is its default — the panel always sends the full picture.
    const automation: ServerAutomation = {};
    for (const key of SERVER_AUTOMATION_KEYS) {
      const v = (body.automation as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== "boolean") return sendError(res, 400, `automation.${key} must be a boolean`);
      if (typeof v === "boolean" && v !== automationDefault(key)) automation[key] = v;
    }
    const before = await ctx.repo.servers.findById(id);
    const updated = await ctx.repo.servers.setAutomation(id, automation);
    if (!updated) return sendError(res, 404, "server not found");
    const off = SERVER_AUTOMATION_KEYS.filter((k) => automationDefault(k) && !automationEnabled(automation, k));
    // The reconcilers' fixes are named whenever they are on, and when one is switched off: those
    // two are the switches that let the app ban, or grant and remove VIP, with nobody pressing.
    const armedNow = SERVER_AUTOMATION_DEFAULT_OFF.filter((k) => automationEnabled(automation, k));
    const disarmed = SERVER_AUTOMATION_DEFAULT_OFF.filter((k) => !automationEnabled(automation, k) && automationEnabled(before?.automation, k));
    const parts = [
      off.length ? `${off.join(", ")} off` : "everything on",
      ...(armedNow.length ? [`fixing automatically: ${armedNow.map((k) => AUTOMATION_FIX_WORDS[k]).join(", ")}`] : []),
      ...(disarmed.length ? [`report only again: ${disarmed.map((k) => AUTOMATION_FIX_WORDS[k]).join(", ")}`] : []),
    ];
    await ctx.repo.audit.create({
      actorUserId: p.user.id,
      actorName: p.name,
      action: "server.automation",
      targetType: "server",
      targetId: id,
      targetName: updated.name,
      serverId: id,
      summary: `set automation on ${updated.name}: ${parts.join("; ")}`,
      data: { automation },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  route("POST", "/api/servers/:id/engagement", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.engagement", "write", { serverId: id })) return sendForbidden(res, "server.engagement", "write");
    if (await decommissionLocked(ctx, p, id)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const mode = str(body.mode);
    if (mode !== "observe" && mode !== "active") return sendError(res, 400, "mode must be 'observe' or 'active'");
    const updated = await ctx.repo.servers.setEngagementMode(id, mode);
    if (!updated) return sendError(res, 404, "server not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id,
      actorName: p.name,
      action: "server.engagement",
      targetType: "server",
      targetId: id,
      targetName: updated.name,
      serverId: id,
      summary: `set ${updated.name} to ${mode} mode`,
      data: { mode },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  /**
   * Streamer mode — start (or stop) answering CRCON's public API names for this server without a
   * login, so streamers' existing CRCON overlay tools work against it (docs/streamer-mode.md).
   *
   * Gated on server.engagement write, the same permission as the observe/active switch: both
   * decide what this server exposes to the outside world, and neither is a routine read. Every
   * flip is audited — turning a public API on is exactly the kind of change that should be
   * answerable months later.
   */
  route("POST", "/api/servers/:id/streamer-mode", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.engagement", "write", { serverId: id })) return sendForbidden(res, "server.engagement", "write");
    if (await decommissionLocked(ctx, p, id)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    if (typeof body.enabled !== "boolean") return sendError(res, 400, "enabled must be true or false");
    const updated = await ctx.repo.servers.setStreamerMode(id, body.enabled);
    if (!updated) return sendError(res, 404, "server not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id,
      actorName: p.name,
      action: "server.streamer_mode",
      targetType: "server",
      targetId: id,
      targetName: updated.name,
      serverId: id,
      summary: body.enabled
        ? `turned the public streamer API ON for ${updated.name} — it now answers without a login`
        : `turned the public streamer API off for ${updated.name}`,
      data: { enabled: body.enabled },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  /*
   * The staff-set alias. Game server names are written for the browser list — long, shouty, and
   * one character apart between siblings — which turns every composed sentence into a reading
   * test. Once set, the alias IS the server's `name` on every repository read (see
   * ServerRow.name), so the whole app — panel, Discord, in-game text, audits — calls the server
   * this without any call site knowing. The one deliberate exception is the public stats page,
   * which keeps the game's real identity and quotes the alias beside it. Blank clears it, and
   * nothing is ever written to the game server: its browser name is the host's, not ours.
   */
  serverRoute("POST", "/api/servers/:id/nickname", "server.manage", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const nickname = boundedText(body.nickname, 60, "nickname") || null;
    const updated = await ctx.repo.servers.setNickname(id, nickname);
    if (!updated) return sendError(res, 404, "no such server");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.nickname",
      targetType: "server", targetId: id, targetName: server.gameName, serverId: id,
      summary: nickname ? `nicknamed ${server.gameName} "${nickname}"` : `cleared the nickname on ${server.gameName}`,
      data: { nickname },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  /**
   * Name the server for the public stats site: its URL slug (/stats/<slug>) and its public
   * display name. Same gate as the publish switch itself — these three settings together ARE the
   * public surface, and whoever may open it may name it. Audited like the switch, because a slug
   * change breaks every link already shared and should be answerable.
   *
   * The slug is the piece of a URL somebody says out loud, so its shape is strict: lowercase
   * letters/digits/hyphens, starting alphanumeric, at most 40 chars. "api" is reserved because
   * /stats/api/* must never be ambiguous between a server named "api" and a future index API.
   */
  route("POST", "/api/servers/:id/public-profile", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.engagement", "write", { serverId: id })) return sendForbidden(res, "server.engagement", "write");
    if (await decommissionLocked(ctx, p, id)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const rawSlug = str(body.publicSlug).trim().toLowerCase();
    const publicSlug = rawSlug === "" ? null : rawSlug;
    if (publicSlug !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(publicSlug)) {
      return sendError(res, 400, "the URL name must be 1–40 characters of lowercase letters, digits and hyphens, starting with a letter or digit");
    }
    // "api" would shadow the API mount under every base; "stats" would make the short link on a
    // dedicated stats hostname (stats.example.com/stats) collide with the site's own index.
    if (publicSlug === "api" || publicSlug === "stats") return sendError(res, 400, `the URL name "${publicSlug}" is reserved`);
    const publicName = boundedText(body.publicName, TEXT_MAX.name, "publicName") || null;
    // Publishing platform ids is its OWN decision (see docs/public-stats.md): omitting the field
    // leaves it as it was, so a caller renaming a server cannot flip it by accident.
    const current = await ctx.repo.servers.findById(id);
    if (!current) return sendError(res, 404, "server not found");
    // Read the old value out NOW: the write below may hand back the very row `current` points at
    // (the in-memory store does), and comparing an object to itself afterwards always says
    // "unchanged" — which would silently drop the id line from the audit trail.
    const wasPublishingIds = current.publicPlayerIds;
    const publicPlayerIds = typeof body.publicPlayerIds === "boolean" ? body.publicPlayerIds : wasPublishingIds;
    let updated: ServerRow | null;
    try {
      updated = await ctx.repo.servers.setPublicProfile(id, { publicSlug, publicName, publicPlayerIds });
    } catch (e) {
      // Only a slug collision maps to 409 — Postgres's unique-violation code or the memory
      // store's message. Anything else (the database being down, say) must not be reported as
      // "name taken", which would send staff hunting for a conflict that does not exist.
      const isTaken = (e as { code?: string }).code === "23505" || /already taken/i.test((e as Error).message ?? "");
      if (isTaken) return sendError(res, 409, `the URL name "${publicSlug}" is already used by another server`);
      throw e;
    }
    if (!updated) return sendError(res, 404, "server not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id,
      actorName: p.name,
      action: "server.public_profile",
      targetType: "server",
      targetId: id,
      targetName: updated.name,
      serverId: id,
      summary: publicSlug
        ? `named ${updated.name} for the public stats site: /stats/${publicSlug}${publicName ? ` as "${publicName}"` : ""}` +
          (publicPlayerIds !== wasPublishingIds ? `, and ${publicPlayerIds ? "STARTED" : "stopped"} publishing player ids` : "")
        : `removed ${updated.name}'s public stats address`,
      data: { publicSlug, publicName, publicPlayerIds },
    });
    sendJson(res, 200, { server: toPublicServer(updated) });
  }),

  /**
   * Admin actions (message / kick / punish / ban / unban). These are WRITES: the engagement
   * guard refuses them on `observe` servers (→ 409), so an observe server can never touch the
   * game — the same invariant that lets us run safely beside an existing CRCON.
   *
   * ONE SERVER by default — the `:id` in the path. A ban lives in the game server's own ban list
   * and Hell Let Loose knows nothing about the community's other servers, so this is the honest
   * default for a kick or a punish, which only mean anything where the player currently is.
   *
   * BANS ARE DIFFERENT, and `serverIds` is how. "Banned from the community" is what staff
   * actually decide, but expressing it meant repeating the same ban on each server in turn, and
   * lifting it meant remembering to repeat the unban — miss one and the player is quietly still
   * banned somewhere nobody is looking. Passing `serverIds` names the exact set: one, several, or
   * all. Only the four ban verbs accept it; there is no such thing as kicking someone from a
   * server they are not on.
   *
   * Each target is checked on its own — permission, observe mode, the role's tempban hour cap —
   * and each success writes its own audit row against its own server, so the Bans page and the
   * moderation history stay per-server records of what is true where. A target that refuses is
   * reported in `results` rather than failing the request: banning on two of three servers and
   * being told plainly about the third beats a 403 that did nothing at all.
   */
  route("POST", "/api/servers/:id/actions", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");

    const body = await readJsonBody(req);
    const action = str(body.action);
    const spec = Object.hasOwn(ADMIN_ACTIONS, action) ? ADMIN_ACTIONS[action] : undefined;
    if (!spec) return sendError(res, 400, `unknown action '${action}'. Known: ${Object.keys(ADMIN_ACTIONS).join(", ")}`);
    for (const field of spec.needs) {
      const v = body[field];
      if (v === undefined || v === null || v === "") return sendError(res, 400, `action '${action}' requires '${field}'`);
    }
    // Checked once against the seed server: fan-out targets are already refused unless they share
    // its game, so an id that is wrong for this server is wrong for every target. Unbans are
    // exempt — lifting a record that was stored under the wrong id must stay possible.
    if (!action.startsWith("unban")) {
      const idRefusal = await crossGameIdError(ctx.repo, server, str(body.playerId));
      if (idRefusal) return sendError(res, 400, idRefusal);
    }

    // The scope is a RULE ("all", "all except #2", "exactly these"), not a list of ids — see
    // ban-scope.ts for why that distinction has to survive into storage. Here it only decides the
    // targets; resolving a rule against a server added later is the reconciler's job.
    const parsed = parseBanScope(body);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    const scope = parsed.scope;
    if (scope && !FANOUT_ACTIONS.has(action)) {
      return sendError(res, 400, `'${action}' applies to one server — a scope is only for ${[...FANOUT_ACTIONS].join(", ")}`);
    }
    // Resolved against the SEED server's game: the `:id` in the path is what tells us which game
    // this player id belongs to, and ids do not cross games.
    //
    // An explicit list is passed through UNRESOLVED on purpose. Resolution silently drops an id
    // that names no server or the wrong game, and for a list the staff member typed those are
    // exactly the cases they need told about — the loop below reports each one. `all` and `except`
    // are generated from the server table, so they cannot contain either mistake.
    const allServers = scope ? await ctx.repo.servers.list() : [];
    const wanted = !scope ? null
      : scope.mode === "servers" ? scope.serverIds
        : resolveBanScope(scope, allServers, server.game).map((s) => s.id);
    if (wanted && !wanted.length) {
      return sendError(res, 400, `that scope covers no ${server.game} server — nothing would be ${action}ed`);
    }

    /*
     * REQUEST MODE: the builder's capture. Everything above already validated this action exactly
     * as an execution would be; with `draft: true` it lands in the user's draft request instead of
     * at the game. Nothing fires while the cart is being filled — that is the whole trust the mode
     * asks for — and ANYONE may add a line: no grant gates a proposal (write-holders' lines simply
     * apply immediately at submit).
     */
    if (body.draft === true) {
      if (scope) return sendError(res, 400, "a request holds one server per line — pick the server, then add the action");
      return sendJson(res, 202, await captureLine(ctx, p, {
        serverId: id, capability: spec.cap, kind: action,
        payload: {
          playerId: str(body.playerId), playerName: str(body.playerName) || null,
          reason: str(body.reason) || undefined, message: str(body.message) || undefined,
          hours: parseHours(body.hours) || undefined, category: str(body.category) || undefined,
        },
        playerId: str(body.playerId), playerName: str(body.playerName) || null,
      }));
    }

    /**
     * One target's outcome. A refusal is data, not an exception — see the route comment.
     *
     * `kind` is what the single-server path needs to keep its original status codes: a role's hour
     * cap is a 403 and a dead server is a 502, and collapsing both into "it didn't work" turned a
     * clear "your role caps you at 2 hours" into an upstream error about a connection.
     */
    interface Outcome { serverId: string; serverName: string; ok: boolean; error?: string; kind?: "denied" | "limit" | "observe" | "missing" | "refused" | "upstream" }
    const results: Outcome[] = [];
    const targets: ServerRow[] = [];

    if (!wanted) {
      // Fine-grained: kicking needs action.kick, banning needs action.tempban/permaban, etc.
      if (!can(p.grants, spec.cap, "write", { serverId: id })) {
        // No write here means the SAME validated action files as an approval request instead of
        // dead-ending in a 403 — lacking the permission IS the ask; there is no separate grant
        // for proposing. 202: accepted, not performed. Whoever holds the write signs it.
        {
          const filed = await fileRequest(ctx, p, [{
            serverId: id, capability: spec.cap, kind: action,
            payload: {
              playerId: str(body.playerId), playerName: str(body.playerName) || null,
              reason: str(body.reason) || undefined, message: str(body.message) || undefined,
              hours: parseHours(body.hours) || undefined, category: str(body.category) || undefined,
            },
            playerId: str(body.playerId), playerName: str(body.playerName) || null,
          }]);
          void postApprovalCard(ctx, filed.id);
          return sendJson(res, 202, { requested: true, requestId: filed.id });
        }
      }
      targets.push(server);
    } else {
      // `serverIds` is the authoritative list when present; the `:id` in the path is only how the
      // request was addressed. Requiring permission on it too would refuse a moderator who can ban
      // on #2 and #3 while their panel happens to be pinned to #1.
      const byId = new Map(allServers.map((s) => [s.id, s]));
      for (const sid of wanted) {
        const s = byId.get(sid);
        if (!s) { results.push({ serverId: sid, serverName: sid, ok: false, error: "no such server", kind: "denied" }); continue; }
        // Player ids do not cross games. A Hell Let Loose Steam64 means nothing to an HLL:
        // Vietnam server (which keys everyone by its own per-game EOS id), so fanning a ban out
        // to a different game's server would at best do nothing and at worst report success for
        // a ban that never landed. The seed server — the one whose context produced this player
        // id — decides which game the id belongs to.
        if (s.game !== server.game) {
          results.push({ serverId: sid, serverName: s.name, ok: false, error: `different game (${s.game}) — this player id only exists on ${server.game} servers`, kind: "denied" });
          continue;
        }
        if (!can(p.grants, spec.cap, "write", { serverId: sid })) {
          results.push({ serverId: sid, serverName: s.name, ok: false, error: `you do not have ${spec.cap} here`, kind: "denied" });
          continue;
        }
        targets.push(s);
      }
      if (!targets.length) return sendForbidden(res, spec.cap, "write");
    }

    // The signature is appended HERE, on the way to the game, and not stored on the audit row's
    // reason. The trail already knows who acted — repeating it there would be noise — while the
    // player is the one person who does not, which is the whole point of the feature.
    const hours = parseHours(body.hours);
    const sign = await signerFor(ctx, action, p);
    const cmdParams: Record<string, unknown> = {
      playerId: str(body.playerId),
      // Both reach the GAME: a reason is recorded against the player and a message is displayed to
      // them. An unbounded one is truncated by the game with no warning back to the panel — and the
      // bound has to cover the signature too, or the appended appeal link is what gets eaten.
      // The header goes on the REASON, because that is the field the game renders in the notice
      // the player actually sees. `message` is a different surface (the admin-message popup) and
      // the game titles that one itself.
      reason: signedText(sign, body.reason, "reason", TEXT_MAX.reason, ACTION_NOTICE_HEADER[action] ?? ""),
      message: signedText(sign, body.message, "message"),
      hours,
      adminName: p.name, // recorded on ban commands for the game's audit trail
    };

    /*
     * THE SPLIT: a single-server temp ban over the actor's own hour cap no longer dead-ends in a
     * 403 asking them to do calendar math. The ban executes AT THE CAP now — that much was always
     * theirs to give — and the remainder files as an approval request. Denial needs no rollback
     * (the capped ban stood on its own authority); approval serves the FULL sentence measured in
     * time actually banned, however long the signature took (see the tempban_extend executor).
     * Fan-out bans keep the plain refusal: a split across servers would mean different remainders
     * per server, which is a bundle for the builder, not an implicit surprise.
     */
    let split: { requestedHours: number; appliedHours: number } | null = null;
    if (action === "tempban" && !wanted && targets.length === 1) {
      const max = await tempbanMaxHours(ctx.repo, p, targets[0]!.id);
      if (Number.isFinite(max) && max > 0 && hours > max) {
        split = { requestedHours: hours, appliedHours: max };
        cmdParams.hours = max;
      }
    }

    // Numbers, not names: server names here run to eighty characters and differ by a digit in the
    // middle, so a summary built from them is unreadable. `numberOf` mirrors the badge in the header.
    const order = new Map(allServers.map((s, i) => [s.id, i + 1]));
    const scopeNote = scope ? ` (${describeBanScope(scope, (sid) => order.get(sid) ?? sid)})` : "";

    // Sequential, one connection at a time: two or three servers is the realistic fan-out, and a
    // ban is not worth opening every RCON socket in the community at once to save a second.
    let lastResult: unknown = null;
    for (const target of targets) {
      // Action limits (numeric caps; owners are never limited). Effective limit follows the same
      // union rule as grants: each source that allows the action contributes its cap (or unlimited
      // if it sets none) and the most permissive wins. Per target — a role may cap the hours on
      // one server and not another. Checked before the connection.
      if (action === "tempban") {
        const refusal = await tempbanRefusal(ctx.repo, p, target.id, Number(cmdParams.hours));
        if (refusal) { results.push({ serverId: target.id, serverName: target.name, ok: false, error: refusal, kind: "limit" }); continue; }
      }
      const client = gameClientFor(target);
      try {
        await connectGameClient(client, target);
        // An unban of an id the server does not list would answer 200 and change nothing, so ask
        // first. Thrown rather than pushed, so it lands in the same failure path as any other
        // refusal — including the audit row and the decision record, neither of which may claim a
        // lift that never happened.
        if (action.startsWith("unban")) {
          const missing = await unbanTargetMissing(client, target, action, str(body.playerId));
          if (missing) throw new UnbanTargetMissing(missing);
        }
        // Placeholders filled per TARGET: a fan-out ban names each server, and {vip_until} is
        // this player's VIP on that server.
        lastResult = await client.execute(spec.command, await renderActionText(ctx.repo, target, cmdParams,
          { playerId: str(body.playerId), playerName: str(body.playerName) || null }, null, client));
        // The 200 is the server's word; the list is the fact. A lift the list still shows lands
        // in the same failure path as a missing target — no audit row, no decision stamped —
        // because both are the same event from the staffer's chair: nothing changed.
        if (action.startsWith("unban")) {
          const held = await unbanStillListed(client, action, str(body.playerId));
          if (held) throw new UnbanTargetMissing(held);
        }
        // Record the action in the audit trail (staff analytics + moderation history). One row per
        // server: a ban on #1 and #2 is two facts, and lifting one must not erase the other.
        //
        // The rule that produced those facts goes on every row. Reading one row back, "banned on
        // #2" and "banned everywhere, of which #2 is one" are different events, and only the
        // second explains why #4 will inherit it later.
        await ctx.repo.audit.create({
          actorUserId: p.user.id,
          actorName: p.name,
          action: `player.${action}`,
          targetType: "player",
          targetId: str(body.playerId),
          serverId: target.id,
          targetName: str(body.playerName) || undefined,
          summary: `ran ${action} on ${str(body.playerName) || str(body.playerId)}${str(body.reason) ? ` — ${str(body.reason)}` : ""}${scopeNote}`,
          // Only what this action actually CONSUMED. The panel's action modals share one form
          // state, so a stray `hours` can arrive on any request — recording it on a message or a
          // kick invents a "Duration" the profile then shows on an action that has none.
          data: { playerId: str(body.playerId), reason: cmdParams.reason || undefined, message: cmdParams.message || undefined, hours: spec.needs.includes("hours") ? cmdParams.hours || undefined : undefined, ...(scope ? { scope } : {}) },
        });
        results.push({ serverId: target.id, serverName: target.name, ok: true });
      } catch (err) {
        const observe = err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation";
        // An unban of a ban this server does not hold is the caller's mistake, not the game
        // server's — reporting it as an upstream fault would send staff looking at the connection.
        const missing = err instanceof UnbanTargetMissing || (err as Error).name === "UnbanTargetMissing";
        // The game ANSWERED and said no (typed by the adapter) — the connection is fine, the
        // request just doesn't fit the server's current state: the player left, or can't be
        // punished while dead. That is a 409-shaped refusal, not a 502. The distinction is
        // load-bearing beyond semantics: gateways (Cloudflare included) replace an origin 502
        // with their own bodyless error page, which is how "player is offline" once reached a
        // moderator's screen as a naked "HTTP 502" with the reason stripped.
        const refused = !observe && !missing && err instanceof RconCommandError;
        const error = refused
          ? await describeGameRefusal(client, target, action, str(body.playerId), str(body.playerName), (err as Error).message)
          : (err as Error).message;
        results.push({ serverId: target.id, serverName: target.name, ok: false, error, kind: observe ? "observe" : missing ? "missing" : refused ? "refused" : "upstream" });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }

    // Addressing one server keeps the original semantics exactly: a failure is the request's
    // failure, not a line in a report nobody reads when they asked about one server.
    if (!wanted) {
      const only = results[0]!;
      if (!only.ok) {
        // A role's hour cap is the caller's problem (403) and a dead game server is ours (502).
        if (only.kind === "limit" || only.kind === "denied") return sendError(res, 403, only.error ?? "refused");
        if (only.kind === "observe") return sendError(res, 409, only.error ?? "observe mode");
        // 409, not 403: the caller is allowed to do this, the server just has nothing to do it to.
        if (only.kind === "missing") return sendError(res, 409, only.error ?? "nothing to lift");
        // Also 409: the game itself refused (player offline / not spawned). Only a server we
        // could not talk to at all is an upstream fault worth a 502.
        if (only.kind === "refused") return sendError(res, 409, only.error ?? "the game refused the action");
        throw errors.upstream(`action failed: ${only.error}`, { serverId: id, action });
      }
    }
    const applied = results.filter((r) => r.ok).length;

    /*
     * Record the DECISION, once, after the game has been told.
     *
     * The audit trail above says what happened on each server; this says what staff meant, and it
     * is the row the Bans page reads and the reconciler compares a server's live ban list against.
     * One row per decision, not per server — the scope rule is on it, so "everywhere" stays one
     * fact that a server added next month can inherit.
     *
     * Written only when something actually landed. A ban that reached no server is not a decision
     * that took effect, and a row for it would have the reconciler apply it later on the operator's
     * behalf — which is not what a failed request means.
     */
    if (applied > 0) {
      const banScope: BanScope = scope ?? { mode: "servers", serverIds: [server.id] };
      if (action === "permaban" || action === "tempban") {
        const effectiveHours = Number(cmdParams.hours);
        const banRow = await ctx.repo.playerBans.create({
          game: server.game,
          playerId: str(body.playerId),
          playerName: str(body.playerName) || null,
          kind: action === "permaban" ? "perma" : "temp",
          reason: str(body.reason) || "(no reason given)",
          category: str(body.category) || null,
          scope: banScope,
          // Hours are what the game takes; a date is what the record keeps, so "how long is left"
          // never has to be recomputed from when somebody clicked.
          expiresAt: action === "tempban" && effectiveHours > 0 ? new Date(Date.now() + effectiveHours * 3_600_000).toISOString() : null,
          createdByUserId: p.user.id,
          createdByName: p.name,
        });
        // The remainder files against THIS decision — approval moves its expiry rather than
        // stacking a second row, so the record reads as one sentence.
        if (split) {
          const filed = await fileRequest(ctx, p, [{
            serverId: server.id, capability: "action.tempban", kind: "tempban_extend",
            payload: {
              playerId: str(body.playerId), playerName: str(body.playerName) || null,
              reason: str(body.reason) || undefined,
              hours: split.requestedHours, appliedHours: split.appliedHours,
              banStart: new Date().toISOString(), banDecisionId: banRow.id,
            },
            playerId: str(body.playerId), playerName: str(body.playerName) || null,
          }]);
          void postApprovalCard(ctx, filed.id);
          return sendJson(res, 200, {
            ok: true, action, result: lastResult ?? null, results, applied, failed: results.length - applied,
            split: { appliedHours: split.appliedHours, requestedHours: split.requestedHours, requestId: filed.id },
          });
        }
      } else if (action === "unban_perma" || action === "unban_temp") {
        // By player and kind rather than by row id — the unban came from a game ban list or a
        // profile button, neither of which knows which decision put it there. But only as far as
        // it REACHED: the servers that actually accepted the lift narrow each decision, and a
        // rule still covering other servers stays active there (see recordUnban).
        await recordUnban(ctx, {
          game: server.game, playerId: str(body.playerId), kind: action === "unban_perma" ? "perma" : "temp",
          liftedServerIds: results.filter((r) => r.ok).map((r) => r.serverId), liftedByName: p.name,
        });
      }
    }

    // `result` stays for callers written against the single-server shape; `results` is the truth
    // when more than one server was named. `ok` is false when nothing landed anywhere, so a total
    // failure never reads as a success to a client that only checks the flag.
    sendJson(res, 200, { ok: applied > 0, action, result: lastResult ?? null, results, applied, failed: results.length - applied });
  }),

  // The same admin actions applied to MANY players over ONE connection — what the Live view's
  // multi-select fires. Same fine-grained capability as the single route (the action's own
  // action.* cap), same temp-ban hour limits, same per-player audit entries. Per-player
  // applied/skipped results; 409 when nothing applied (observe mode included).
  route("POST", "/api/servers/:id/actions/bulk", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const action = str(body.action);
    const spec = Object.hasOwn(ADMIN_ACTIONS, action) ? ADMIN_ACTIONS[action] : undefined;
    if (!spec) return sendError(res, 400, `unknown action '${action}'. Known: ${Object.keys(ADMIN_ACTIONS).join(", ")}`);
    if (!can(p.grants, spec.cap, "write", { serverId: id })) return sendForbidden(res, spec.cap, "write");

    // One renderer for the whole batch: the server's VIP list and timezone are read once, not per player.
    let bulkRenderer: MessageRenderer | null = null;
    const rawPlayers = Array.isArray(body.players) ? body.players : [];
    const targets = rawPlayers
      .map((x) => ({ playerId: str((x as Record<string, unknown>)?.playerId).trim(), playerName: str((x as Record<string, unknown>)?.playerName) || null }))
      .filter((x) => x.playerId);
    if (!targets.length) return sendError(res, 400, "players is required: [{ playerId, playerName? }, …]");
    if (targets.length > 200) return sendError(res, 400, "too many players in one call (max 200)");
    for (const field of spec.needs) {
      if (field === "playerId") continue; // per-player, from the list
      const v = body[field];
      if (v === undefined || v === null || v === "") return sendError(res, 400, `action '${action}' requires '${field}'`);
    }
    const hours = parseHours(body.hours);
    if (action === "tempban") {
      const refusal = await tempbanRefusal(ctx.repo, p, id, hours);
      if (refusal) return sendError(res, 403, refusal);
    }
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");

    // One lookup for the whole batch, not one per player: two hundred kicks must not be two
    // hundred config reads.
    const sign = await signerFor(ctx, action, p);
    const signedReason = signedText(sign, body.reason, "reason", TEXT_MAX.reason, ACTION_NOTICE_HEADER[action] ?? "");
    const signedMessage = signedText(sign, body.message, "message");

    const applied: { playerId: string; playerName: string | null }[] = [];
    const skipped: { playerId: string; playerName: string | null; reason: string }[] = [];
    /** Unbans the game accepted, awaiting the post-batch list read that proves the lifts took. */
    const unbanPending: { playerId: string; playerName: string | null }[] = [];
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      // For a bulk unban the ban list is read ONCE and judged per player — reading it inside the
      // loop was one identical list read per player, two hundred on a full selection.
      const unbanKind = action === "unban_perma" ? "perma" : "temp";
      const unbanListed = action.startsWith("unban")
        ? await client.execute(unbanKind === "perma" ? "getPermaBans" : "getTempBans")
            .then((r) => normalizeGameBans(r, unbanKind)).catch(() => null)
        : null;
      for (const t of targets) {
        // Live-view selections carry the roster's own ids, but group members and pasted lists can
        // smuggle in the other game's — and Vietnam would accept the command and match nobody.
        // Unbans are exempt (same rule as the single route): a record stored under the wrong id
        // must stay liftable.
        const idRefusal = action.startsWith("unban") ? null : await crossGameIdError(ctx.repo, server, t.playerId);
        if (idRefusal) { skipped.push({ playerId: t.playerId, playerName: t.playerName, reason: idRefusal }); continue; }
        try {
          // Same check as the single route: an unban of an id the server does not list is
          // indistinguishable from one that worked unless the ban list is consulted.
          if (action.startsWith("unban")) {
            // Judged against the list read once above — the whole point of reading it there.
            const missing = unbanTargetMissingIn(unbanListed, server, action, t.playerId);
            if (missing) throw new Error(missing);
          }
          const params = await renderActionText(ctx.repo, server, {
            playerId: t.playerId, reason: signedReason, message: signedMessage,
            hours, adminName: p.name,
          }, t, (bulkRenderer ??= rendererFor(ctx.repo, server, client)));
          if (action === "message") {
            // Paced, with a retry: a burst of messages is exactly what a busy server drops, and a
            // selection of a whole team is a burst. The same spacing "message everyone" uses.
            await sendPlayerMessage(client, t.playerId, String(params.message ?? ""));
            await pauseMs(MESSAGE_PACE_MS);
          } else {
            await client.execute(spec.command, params);
          }
          // Unbans are RECORDED after the whole batch, once the list has confirmed the lifts
          // actually took — see the post-loop verification below. Everything else records here.
          if (action.startsWith("unban")) { unbanPending.push({ playerId: t.playerId, playerName: t.playerName }); continue; }
          await ctx.repo.audit.create({
            actorUserId: p.user.id, actorName: p.name, action: `player.${action}`,
            targetType: "player", targetId: t.playerId, targetName: t.playerName ?? undefined, serverId: id,
            summary: `ran ${action} on ${t.playerName || t.playerId} (bulk, ${targets.length} selected)${str(body.reason) ? ` — ${str(body.reason)}` : ""}`,
            // Same rule as the single-player route: record hours only when the action takes them.
            data: { playerId: t.playerId, reason: str(body.reason) || undefined, message: str(body.message) || undefined, hours: spec.needs.includes("hours") ? hours || undefined : undefined, bulk: true },
          });
          // Same decision record as the single-player route. A bulk ban is still a ban, and a
          // reconciler that never heard about it would later see the game enforcing something with
          // no row behind it and report it as placed outside the panel — which it was not.
          // Bulk has no scope picker, so the decision is exactly this server.
          if (action === "permaban" || action === "tempban") {
            await ctx.repo.playerBans.create({
              game: server.game, playerId: t.playerId, playerName: t.playerName,
              kind: action === "permaban" ? "perma" : "temp",
              reason: str(body.reason) || "(no reason given)",
              category: str(body.category) || null,
              scope: { mode: "servers", serverIds: [id] },
              expiresAt: action === "tempban" && hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
              createdByUserId: p.user.id, createdByName: p.name,
            });
          }
          // (Unbans never reach here — they continue to unbanPending above, and are recorded
          // after the post-batch verification, where recordUnban narrows their decisions.)
          applied.push({ playerId: t.playerId, playerName: t.playerName });
        } catch (err) {
          skipped.push({ playerId: t.playerId, playerName: t.playerName, reason: (err as Error).message });
        }
      }

      /*
       * The post-batch half of the unban story: one list read verifies every lift the game
       * accepted (the same one-read economy as the pre-read above), and only the lifts the list
       * confirms are recorded — audit row, decision narrowing, `applied` line. A 200 with the
       * entry still listed is the lie unbanStillListed documents; here it costs one grace pause
       * and a second read before any player is convicted, and an unreadable list stays what it
       * is everywhere else: no evidence, so the game's word stands.
       */
      if (unbanPending.length) {
        const readAfter = () => client.execute(unbanKind === "perma" ? "getPermaBans" : "getTempBans")
          .then((r) => normalizeGameBans(r, unbanKind)).catch(() => null);
        let after = await readAfter();
        const stillHas = (list: { playerId: string }[] | null, id: string) =>
          list !== null && list.some((b) => b.playerId.trim() === id.trim());
        if (after !== null && unbanPending.some((t) => stillHas(after, t.playerId))) {
          await new Promise((r) => setTimeout(r, 750)); // the list may trail the removals
          after = await readAfter();
        }
        for (const t of unbanPending) {
          if (stillHas(after, t.playerId)) {
            skipped.push({ playerId: t.playerId, playerName: t.playerName, reason: `the server answered as if the lift succeeded, but its ${unbanKind}-ban list still holds this id — nothing was recorded as lifted` });
            continue;
          }
          try {
            await ctx.repo.audit.create({
              actorUserId: p.user.id, actorName: p.name, action: `player.${action}`,
              targetType: "player", targetId: t.playerId, targetName: t.playerName ?? undefined, serverId: id,
              summary: `ran ${action} on ${t.playerName || t.playerId} (bulk, ${targets.length} selected)${str(body.reason) ? ` — ${str(body.reason)}` : ""}`,
              data: { playerId: t.playerId, reason: str(body.reason) || undefined, bulk: true },
            });
            await recordUnban(ctx, {
              game: server.game, playerId: t.playerId, kind: action === "unban_perma" ? "perma" : "temp",
              liftedServerIds: [id], liftedByName: p.name,
            });
            applied.push({ playerId: t.playerId, playerName: t.playerName });
          } catch (err) {
            skipped.push({ playerId: t.playerId, playerName: t.playerName, reason: (err as Error).message });
          }
        }
      }
    } catch (err) {
      const done = new Set([...applied, ...skipped].map((r) => r.playerId));
      for (const t of targets) if (!done.has(t.playerId)) skipped.push({ playerId: t.playerId, playerName: t.playerName, reason: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `nothing applied: ${skipped.slice(0, 5).map((s) => `${s.playerName || s.playerId} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped });
  }),

  // Raw RCON console — send an un-abstracted command straight to the server. Powerful, so it's
  // gated by its own admin.console capability and audited. It respects engagement mode: on
  // observe the adapter refuses it (→ 409), same safety as every other write path.
  serverRoute("POST", "/api/servers/:id/raw", "admin.console", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const command = str(body.command).trim();
    if (!command) return sendError(res, 400, "command is required");

    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const result = await client.raw({ command, version: body.version != null ? Number(body.version) : undefined, body: body.body });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "console.raw",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `ran raw command \`${command}\``, data: { command },
      });
      sendJson(res, 200, { result });
    } catch (err) {
      if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") return sendError(res, 409, (err as Error).message);
      throw errors.upstream(`raw command failed: ${(err as Error).message}`, { serverId: id, command });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  /*
   * The server's own command catalogue, diffed against what we know and what we drive.
   *
   * The v2 verb list lives on the RUNNING game server (`GetDisplayableCommands`) — the official
   * client ships no copy of it (the RCON_504 package is byte-identical to 5.03's everywhere that
   * matters), so after a game update the only place "what can this server do now" exists is the
   * server itself. Each verb comes back tagged: `wired` (a panel feature drives it), `known` (in
   * our 5.03-era baseline but not driven), or `new` (absent from that baseline — the update
   * additions this route exists to surface). Read-only and side-effect free on the game.
   */
  serverRoute("GET", "/api/servers/:id/rcon-commands", "server.config", "read", async ({ res, id, server }) => {
    if (server.protocol !== "binary-v2") {
      const why = server.protocol === "legacy-text"
        ? "the legacy text protocol has no live catalogue — its surface is fixed by the official client's Commands.xml"
        : "the CRCON bridge does not expose the game's own command catalogue";
      return sendError(res, 409, `${why}. Connect this server over binary-v2 to probe it.`);
    }
    const wired = new Set<string>();
    for (const def of Object.values(getGame(server.game)?.commands ?? {})) {
      if (def.binaryV2?.name) wired.add(def.binaryV2.name);
    }
    const known = new Set<string>(V2_CATALOGUE_503);
    const client = gameClientFor(server);
    let raw: unknown;
    try {
      await connectGameClient(client, server);
      raw = await client.execute("getServerCommands");
    } catch (err) {
      throw errors.upstream(`could not read the server's command list: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
    // The container key has varied by source (`entries` on live captures; the official client's
    // DTO property is `AvailableServerCommands`), so take whichever array is present rather than
    // betting on one spelling.
    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const list = [obj.entries, obj.availableServerCommands, ...Object.values(obj)].find(Array.isArray) as unknown[] | undefined;
    if (!list) throw errors.upstream("the server answered, but not with a command list this panel recognizes", { serverId: id });
    const rank = { new: 0, known: 1, wired: 2 } as const;
    const commands = list
      .map((e) => {
        const r = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        const cmdId = str(r.iD ?? r.id ?? r.commandName ?? r.name).trim();
        const status: keyof typeof rank = wired.has(cmdId) ? "wired" : known.has(cmdId) ? "known" : "new";
        return { id: cmdId, friendly: str(r.friendlyName).trim() || null, clientSupported: r.isClientSupported === true, status };
      })
      .filter((c) => c.id)
      .sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
    sendJson(res, 200, {
      commands,
      counts: {
        new: commands.filter((c) => c.status === "new").length,
        known: commands.filter((c) => c.status === "known").length,
        wired: commands.filter((c) => c.status === "wired").length,
      },
      baseline: "official 5.03-era catalogue (live capture 2026-07-23)",
    });
  }),

  // Live state via rcon-core, honoring the server's engagement mode (observe = read-only).
  serverRoute("GET", "/api/servers/:id/live", "server.view", "read", async ({ res, ctx, id, server, p }) => {
    // Every watching admin polls this every ~15s. An uncached hit answers from the worker's latest
    // reads while they are fresh (sharedLiveRead), and otherwise costs a full RCON connect + login
    // + three reads against the game server — on top of the persistent connections the worker
    // already holds. One short shared payload per server collapses all viewers to at most one
    // read per interval; 4s is well under the poll period, so nobody sees data meaningfully
    // staler than they already did, and concurrent viewers coalesce onto the same in-flight read
    // instead of racing their own connections. The cache sits AFTER the permission check — an
    // unauthorized caller never reaches it.
    const cached = liveCache.get(id);
    const read = cached && Date.now() - cached.at < LIVE_CACHE_MS ? cached.read : readLiveOnce(ctx, id, server);
    try {
      const live = await read;
      // Why a player is watched, and by whom, is the watchlist permission's to show, as on the
      // profile; the 👁 itself is everyone's. The roster is shared by every viewer of the server,
      // so it is cut per reader here, on a copy.
      sendJson(res, 200, canAnywhere(p.grants, "player.watchlist", "read") ? live : withoutWatchReasons(live));
    } catch (err) {
      liveCache.delete(id); // a failed read must not be served to the next viewer
      throw errors.upstream(`could not read server: ${(err as Error).message}`, { serverId: id, host: server.host, port: server.port });
    }
  }),

  // --- Console admins (DB-owned expiry, exactly like VIP) ---
  // The GAME SERVER's own admin list: who may use in-game admin powers such as admin camera and
  // console kicks. Entirely separate from panel logins. the panel's row is the book of record —
  // the game only supports permanent admins, so the expiration (null = permanent) lives here and
  // the worker sweeps lapsed grants off the game. The server's admin groups are read live (with a
  // fallback to the game's stock groups) so the panel offers real choices even when the box is down.
  serverRoute("GET", "/api/servers/:id/admins", "server.admins", "read", async ({ res, ctx, id, server }) => {
    const admins = await ctx.repo.consoleAdmins.list(id);
    // Groups still come from the game when reachable — they're the game's vocabulary, not ours.
    let groups = HLL_DEFAULT_ADMIN_GROUPS;
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const live = parseAdminGroups(await client.execute("getAdminGroups"));
      if (live.length) groups = live;
    } catch {
      // Server unreachable — the stored list still shows; the stock groups keep the add form usable.
    } finally {
      await client.disconnect().catch(() => {});
    }
    sendJson(res, 200, { serverId: id, count: admins.length, admins, groups });
  }),

  // Grant / extend a console-admin. Modes: permanent | until | duration (cumulative optional) —
  // the same shapes as VIP. `allServers` applies it to every server the caller may manage. Issues
  // the native game AddAdmin and records our own expiry row.
  route("POST", "/api/servers/:id/admins", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const body = await readJsonBody(req);
    // "All servers" is a cross-server request: gate it on holding the capability ANYWHERE (the
    // target list below keeps only permitted servers) — a staff member with rights on server 2
    // alone, pinned to server 1, must not be refused before the filter even runs.
    if (!(body.allServers ? canAnywhere(p.grants, "server.admins", "write") : can(p.grants, "server.admins", "write", { serverId: id }))) return sendForbidden(res, "server.admins", "write");
    const base = await ctx.repo.servers.findById(id);
    if (!base) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, base)) return sendError(res, 404, "server not found");
    const playerId = str(body.playerId).trim();
    if (!playerId) return sendError(res, 400, "playerId is required");
    const group = str(body.group).trim();
    if (!group) return sendError(res, 400, "group is required (one of the server's admin groups)");
    const comment = boundedText(body.comment, TEXT_MAX.note, "comment") || null; // internal admin note only — NOT sent to the game

    // The game's admin entry shows a Comment as its label; use the readable name, never the raw id.
    let displayName = str(body.playerName) || str(body.name) || null;
    if (!displayName) {
      const hits = await ctx.repo.players.search(playerId, 5);
      displayName = hits.find((pl) => pl.platformId === playerId || pl.id === playerId)?.name ?? null;
    }
    const gameAdminLabel = displayName || comment || "admin";

    const all = await ctx.repo.servers.list();
    const targets = body.allServers ? all.filter((s) => can(p.grants, "server.admins", "write", { serverId: s.id })) : [base];
    const applied: { serverId: string; serverName: string; expiration: string | null }[] = [];
    const skipped: { serverId: string; serverName: string; reason: string }[] = [];

    for (const server of targets) {
      const existing = await ctx.repo.consoleAdmins.get(server.id, playerId);
      let expiration: string | null;
      try { expiration = computeGrantExpiration(body, existing); }
      catch (err) { return sendError(res, 400, (err as Error).message); }
      // Before anything is stored: an id the game cannot act on must not become a grant row.
      const idRefusal = await crossGameIdError(ctx.repo, server, playerId);
      if (idRefusal) { skipped.push({ serverId: server.id, serverName: server.name, reason: idRefusal }); continue; }
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        // Validate against the server's real groups so a typo can't create a broken entry.
        const groups = parseAdminGroups(await client.execute("getAdminGroups").catch(() => null));
        if (groups.length && !groups.includes(group)) { skipped.push({ serverId: server.id, serverName: server.name, reason: `"${group}" is not one of this server's admin groups (${groups.join(", ")})` }); continue; }
        await client.execute("addAdmin", { playerId, group, comment: gameAdminLabel });
        const row = await ctx.repo.consoleAdmins.upsert({ serverId: server.id, playerId, playerName: displayName, adminGroup: group, comment, expiration, createdByUserId: p.user.id, createdByName: p.name });
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "server.admin_add",
          targetType: "player", targetId: playerId, targetName: displayName ?? undefined, serverId: server.id,
          summary: `made ${displayName || playerId} a console admin (${group}) on ${server.name} (${expiration ? `until ${expiration}` : "permanent"})`,
          data: { playerId, group, comment, expiration },
        });
        applied.push({ serverId: server.id, serverName: server.name, expiration: row.expiration });
      } catch (err) {
        if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") skipped.push({ serverId: server.id, serverName: server.name, reason: "observe mode (read-only)" });
        else skipped.push({ serverId: server.id, serverName: server.name, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `console admin not applied: ${skipped.map((s) => `${s.serverName} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped });
  }),

  // Remove a console admin: take them off the game AND delete our row. `?allServers=1` removes everywhere.
  route("DELETE", "/api/servers/:id/admins/:playerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const allServers = new URL(req.url ?? "", "http://x").searchParams.get("allServers") === "1";
    // Same asymmetry as the grant: all-servers removal needs the capability anywhere, not on the
    // base server specifically — the target filter below applies the per-server scope.
    if (!(allServers ? canAnywhere(p.grants, "server.admins", "write") : can(p.grants, "server.admins", "write", { serverId: id }))) return sendForbidden(res, "server.admins", "write");
    const base = await ctx.repo.servers.findById(id);
    if (!base) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, base)) return sendError(res, 404, "server not found");
    const playerId = params.playerId!.trim();
    if (!playerId) return sendError(res, 400, "playerId is required");
    const all = await ctx.repo.servers.list();
    const targets = allServers ? all.filter((s) => can(p.grants, "server.admins", "write", { serverId: s.id })) : [base];
    const applied: string[] = [];
    const skipped: { serverName: string; reason: string }[] = [];

    for (const server of targets) {
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        await client.execute("removeAdmin", { playerId });
        await ctx.repo.consoleAdmins.remove(server.id, playerId);
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "server.admin_remove",
          targetType: "player", targetId: playerId, serverId: server.id,
          summary: `removed console admin ${playerId} on ${server.name}`, data: { playerId },
        });
        applied.push(server.id);
      } catch (err) {
        if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") skipped.push({ serverName: server.name, reason: "observe mode (read-only)" });
        else skipped.push({ serverName: server.name, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `console admin not removed: ${skipped.map((s) => `${s.serverName} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped });
  }),

  // Live ban list read straight from the game server (GetTemporaryBans + GetPermanentBans),
  // normalized to a common shape. This is the authoritative ban list — distinct from GET /bans,
  // which is what *we* did (audit-derived). Reads are allowed on observe servers (the getter
  // passes the engagement guard); normalization returns [] for protocols that don't expose the
  // structured v2 shape, so the endpoint degrades cleanly rather than erroring.
  /*
   * Clear ONE server of every ban it enforces — the "wipe the slate on #1" operation.
   *
   * Two halves, in an order that matters. The DECISIONS go first: each active decision covering
   * this server is narrowed by exactly it — a rule scoped only here is stamped lifted, a broader
   * rule shrinks to the servers still banned ("all" becomes "all except this one"), so nobody is
   * quietly unbanned anywhere staff did not name. Then the GAME's own lists are emptied — every
   * temp and perma entry, including bans placed outside the panel, because "everyone ever banned
   * from this server" includes the history no decision row knows about. Decisions-first means a
   * game failure cannot leave an armed reconciler re-applying what was just lifted; the entries
   * left behind read as unbanned decisions and the reconciler (or a later Sync) sweeps them.
   *
   * Refused outright on observe mode BEFORE anything changes: lifting the record while the game
   * keeps enforcing is the exact split-brain recordUnban exists to prevent, and on observe the
   * pardons cannot be sent.
   */
  serverRoute("POST", "/api/servers/:id/bans/lift-all", "action.unban", "write", async ({ res, ctx, p, id, server }) => {
    if (server.engagementMode === "observe") {
      return sendError(res, 409, "this server is in observe mode (read-only) — the record would say unbanned while the game keeps enforcing. Switch it to active first.");
    }
    const servers = await ctx.repo.servers.list();
    const decisions = (await ctx.repo.playerBans.list({ activeOnly: true }))
      .filter((b) => b.game === server.game)
      .filter((b) => resolveBanScope(b.scope as BanScope, servers, b.game).some((sv) => sv.id === id));
    let lifted = 0, narrowed = 0;
    for (const d of decisions) {
      const r = narrowBanScope(d.scope as BanScope, [id], servers, d.game);
      if (r.outcome === "lift") { if (await ctx.repo.playerBans.lift(d.id, p.name)) lifted++; }
      else if (r.outcome === "narrow") { if (await ctx.repo.playerBans.setScope(d.id, r.scope)) narrowed++; }
    }
    let cleared = 0;
    // Temp bans the game still lists after their own time ran out: it no longer enforces them and
    // refuses to remove them, so they are counted rather than sent (gameBanRanOut).
    let ranOut = 0;
    const failed: { playerId: string; reason: string }[] = [];
    let gameError: string | null = null;
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const [temp, perma] = await Promise.all([client.execute("getTempBans"), client.execute("getPermaBans")]);
      const entries = [...normalizeGameBans(temp, "temp"), ...normalizeGameBans(perma, "perma")];
      const seen = new Set<string>();
      const now = Date.now();
      for (const b of entries) {
        if (!b.playerId) continue;
        const key = `${b.type}:${b.playerId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (gameBanRanOut(b, now)) { ranOut++; continue; }
        try {
          await client.execute(b.type === "perma" ? "removePermaBan" : "removeTempBan", { playerId: b.playerId });
          cleared++;
        } catch (e) {
          failed.push({ playerId: b.playerId, reason: (e as Error).message });
        }
      }
    } catch (err) {
      // The record half already happened and stands: an unreachable server's leftover entries now
      // read as unbanned decisions, which the reconciler or the Bans page's Sync sweeps later.
      gameError = (err as Error).message;
    } finally {
      await client.disconnect().catch(() => {});
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "ban.lift_all",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `lifted every ban on ${server.name}: ${lifted} decision(s) lifted, ${narrowed} narrowed to other servers, ${cleared} entr${cleared === 1 ? "y" : "ies"} cleared off the game${ranOut ? `, ${ranOut} temp ban(s) it still lists had already run out` : ""}${failed.length ? `, ${failed.length} failed` : ""}${gameError ? ` — game list not cleared (${gameError})` : ""}`,
      data: { lifted, narrowed, cleared, ranOut, failed, gameError },
    });
    sendJson(res, 200, { lifted, narrowed, cleared, ranOut, failed, gameError });
  }),

  serverRoute("GET", "/api/servers/:id/bans/live", "moderation.bans", "read", async ({ res, id, server }) => {

    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const [temp, perma] = await Promise.all([client.execute("getTempBans"), client.execute("getPermaBans")]);
      const bans = [...normalizeGameBans(temp, "temp"), ...normalizeGameBans(perma, "perma")];
      // A temp ban the game lists after its own time ran out holds nobody, and the game refuses to
      // remove it — flagged, so the list says so rather than offering an Unban it would refuse.
      const now = Date.now();
      sendJson(res, 200, { serverId: id, count: bans.length, bans: bans.map((b) => ({ ...b, ranOut: gameBanRanOut(b, now) })) });
    } catch (err) {
      throw errors.upstream(`could not read ban list: ${(err as Error).message}`, { serverId: id, host: server.host, port: server.port });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // --- VIP management (DB-owned expiry, like CRCON) ---
  // List VIP grants for a server. Source of truth is our DB (the game's native VIP has no expiry);
  // rows include expiration (null = permanent) so the UI can show status.
  route("GET", "/api/servers/:id/vips", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "vip.grant", "read", { serverId: id }) && !can(p.grants, "vip.revoke", "read", { serverId: id })) return sendForbidden(res, "vip.grant", "read");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    const vips = await ctx.repo.vips.list(id);
    /*
     * The VIP-perk groups covering this server that list each player. A perk never takes over a
     * permanent the player already owns, so that row carries no hold — and on the VIP page it reads
     * as the group's VIP with their own permanent paused beneath it, which is what it is. Display
     * only: nothing about the grant changes.
     *
     * Only where the perk acts, as the worker decides it: on a server it may write on, and for a
     * player it can place in this server's game. Elsewhere the group gives that player nothing
     * here — their permanent is all the VIP they have, and the page must not say a group would
     * take over if it were revoked.
     */
    const perkGroups = new Map<string, { id: string; name: string }[]>();
    if (perkWritable(server)) {
      const listed = new Set(vips.map((v) => v.playerId));
      for (const g of await ctx.repo.playerGroups.list()) {
        if (!g.vipPerk || g.vipPerk.game !== server.game || !banScopeCovers(g.vipPerk.scope, id)) continue;
        for (const m of await ctx.repo.playerGroups.members(g.id)) {
          if (!listed.has(m.playerId)) continue;
          const list = perkGroups.get(m.playerId) ?? [];
          if (!list.some((x) => x.id === g.id)) list.push({ id: g.id, name: g.name });
          perkGroups.set(m.playerId, list);
        }
      }
      if (perkGroups.size) {
        const gameOf = new Map((await ctx.repo.players.findByPlatformIds([...perkGroups.keys()])).map((pl) => [pl.platformId, pl.game]));
        for (const playerId of [...perkGroups.keys()]) if (memberGameVerdict(playerId, server.game, gameOf) !== "ok") perkGroups.delete(playerId);
      }
    }
    sendJson(res, 200, { serverId: id, count: vips.length, vips: vips.map((v) => (perkGroups.has(v.playerId) ? { ...v, perkGroups: perkGroups.get(v.playerId) } : v)) });
  }),

  // Grant / extend VIP. Modes: permanent | until (absolute date) | duration (days/hours, optionally
  // cumulative onto an existing future grant). `allServers` applies it to every server. Issues the
  // native game AddVip and records our own expiry row; the worker sweeps expired ones off the game.
  route("POST", "/api/servers/:id/vips", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    // Before every branch — the draft capture included: a request line naming a server that does
    // not exist for its filer must not enter the approvals queue either.
    if (await decommissionLocked(ctx, p, id)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    // All-servers grants gate on holding vip.grant ANYWHERE; the per-server scope is applied by
    // the target filter below. A single-server grant still gates on that exact server.
    // REQUEST MODE: capture a VIP grant into the draft — validated first, exactly like a grant.
    if (body.draft === true) {
      if (body.allServers) return sendError(res, 400, "a request holds one server per line — pick the server, then add the grant");
      const draftServer = await ctx.repo.servers.findById(id);
      if (!draftServer) return sendError(res, 404, "server not found");
      const draftPlayerId = str(body.playerId).trim();
      if (!draftPlayerId) return sendError(res, 400, "playerId is required");
      try { computeGrantExpiration(body, await ctx.repo.vips.get(id, draftPlayerId)); }
      catch (err) { return sendError(res, 400, (err as Error).message); }
      // The line lands as a grant once signed, so it carries the grant's comment from the start.
      const draftComment = requiredVipComment(body.comment);
      return sendJson(res, 202, await captureLine(ctx, p, {
        serverId: id, capability: "vip.grant", kind: "vip",
        payload: {
          playerId: draftPlayerId, playerName: str(body.playerName) || null, comment: draftComment,
          mode: str(body.mode) || undefined, expiresAt: str(body.expiresAt) || undefined,
          days: Number(body.days ?? 0) || undefined, hours: Number(body.hours ?? 0) || undefined,
          cumulative: body.cumulative === undefined ? undefined : Boolean(body.cumulative),
        },
        playerId: draftPlayerId, playerName: str(body.playerName) || null,
      }));
    }
    if (!(body.allServers ? canAnywhere(p.grants, "vip.grant", "write") : can(p.grants, "vip.grant", "write", { serverId: id }))) {
      // No write here → the SAME validated grant files as a request (single server only — an
      // all-servers request is a bundle for the builder). Lacking the permission IS the ask.
      if (!body.allServers) {
        const askServer = await ctx.repo.servers.findById(id);
        if (!askServer) return sendError(res, 404, "server not found");
        const askPlayerId = str(body.playerId).trim();
        if (!askPlayerId) return sendError(res, 400, "playerId is required");
        try { computeGrantExpiration(body, await ctx.repo.vips.get(id, askPlayerId)); }
        catch (err) { return sendError(res, 400, (err as Error).message); }
        const askComment = requiredVipComment(body.comment);
        const filed = await fileRequest(ctx, p, [{
          serverId: id, capability: "vip.grant", kind: "vip",
          payload: {
            playerId: askPlayerId, playerName: str(body.playerName) || null, comment: askComment,
            mode: str(body.mode) || undefined, expiresAt: str(body.expiresAt) || undefined,
            days: Number(body.days ?? 0) || undefined, hours: Number(body.hours ?? 0) || undefined,
            cumulative: body.cumulative === undefined ? undefined : Boolean(body.cumulative),
          },
          playerId: askPlayerId, playerName: str(body.playerName) || null,
        }]);
        void postApprovalCard(ctx, filed.id);
        return sendJson(res, 202, { requested: true, requestId: filed.id });
      }
      return sendForbidden(res, "vip.grant", "write");
    }
    const base = await ctx.repo.servers.findById(id);
    if (!base) return sendError(res, 404, "server not found");
    const playerId = str(body.playerId).trim();
    if (!playerId) return sendError(res, 400, "playerId is required");
    // Required, and bounded like the console-admin route's comment (kit.ts requiredVipComment).
    // Internal admin note only — NOT sent to the game.
    const comment = requiredVipComment(body.comment);

    // The game's VIP entry shows a display *name* (CRCON stores the readable name there, never the
    // id). Resolve it: the name the panel passed, else look it up from our player store by id,
    // else fall back to the note. We never send the raw id as the display name.
    let displayName = str(body.playerName) || null;
    if (!displayName) {
      const hits = await ctx.repo.players.search(playerId, 5);
      displayName = hits.find((p) => p.platformId === playerId || p.id === playerId)?.name ?? null;
    }
    const gameVipName = displayName || comment || "VIP";

    // Target one server, or every server the caller may manage VIP on.
    const all = await ctx.repo.servers.list();
    const targets = body.allServers ? all.filter((s) => can(p.grants, "vip.grant", "write", { serverId: s.id })) : [base];
    const applied: { serverId: string; serverName: string; expiration: string | null; note?: string }[] = [];
    const skipped: { serverId: string; serverName: string; reason: string }[] = [];

    for (const server of targets) {
      // Before anything is stored: an all-servers grant spans both games, and the id that is right
      // for the WW2 servers is one HLL: Vietnam cannot act on — that server is skipped WITH the
      // reason instead of banking a VIP row the game will never honor.
      const idRefusal = await crossGameIdError(ctx.repo, server, playerId);
      if (idRefusal) { skipped.push({ serverId: server.id, serverName: server.name, reason: idRefusal }); continue; }
      let existing = await ctx.repo.vips.get(server.id, playerId);
      let expiration: string | null;
      try { expiration = computeGrantExpiration(body, existing); }
      catch (err) { return sendError(res, 400, (err as Error).message); }
      // A group perk holds this grant permanent: time joins the frozen balance they get back on
      // leaving (nothing changes on the game — they are already VIP there). Granting PERMANENT
      // takes the grant over instead, below — whether or not a hold was there when it was read.
      const intent = grantForHeld(body);
      const bankedNote = async (row: VipRow) => {
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
          targetType: "player", targetId: playerId, targetName: displayName ?? undefined, serverId: server.id,
          summary: `granted VIP to ${displayName || playerId} on ${server.name} — they hold ${heldBy(row.groupHold!)}, so it was added to the VIP they get back on leaving (${Math.round(row.groupHold!.bankedMs / 3_600_000)}h banked)`,
          data: { playerId, groupHeld: true, bankedMs: row.groupHold!.bankedMs, comment },
        });
        applied.push({ serverId: server.id, serverName: server.name, expiration: null, note: `they hold ${heldBy(row.groupHold!)} — added to the VIP they get back on leaving` });
      };
      if (existing?.groupHold && intent.kind === "bank") {
        const basis = await bankIfHeld(ctx.repo, server.id, playerId, intent.change);
        if (basis.banked) { await bankedNote(basis.banked); continue; }
        // The hold ended between the read and the bank: grant from the row its release left.
        existing = basis.existing;
        expiration = computeGrantExpiration(body, existing);
      }
      const takesOver = intent.kind === "permanent";
      const client = gameClientFor(server);
      // A paused VIP still ACCUMULATES time (upsert extends the row) but must not reappear on the
      // game until the pause lapses — the grant is banked, the timeout stands.
      const vipPaused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
      try {
        if (!vipPaused) {
          await connectGameClient(client, server);
          await client.execute("addVip", { playerId, description: gameVipName }); // in-game label = readable name
        }
        // replacePermanent: this editor is the one surface where "set to 30 days" aimed at ONE
        // named player, permanent grant on screen, is a deliberate replacement (the cumulative
        // path already absorbed permanent inside computeGrantExpiration and arrives here null).
        const row = await ctx.repo.vips.upsert({ serverId: server.id, playerId, playerName: displayName, comment, expiration, createdByUserId: p.user.id, createdByName: p.name, replacePermanent: true, ...(takesOver ? { endsGroupHold: true } : {}) });
        // A hold that began after the read took the dated grant into its frozen balance.
        if (row.groupHold) { await bankedNote(row); continue; }
        // The store says whether it ended a hold — one that began after the read included.
        const tookOver = row.endedHold ?? null;
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
          targetType: "player", targetId: playerId, targetName: displayName ?? undefined, serverId: server.id,
          summary: `granted VIP to ${displayName || playerId} on ${server.name} (${expiration ? `until ${expiration}` : "permanent"})${tookOver ? ` — it was ${heldBy(tookOver)}; it is theirs now, and leaving the group no longer ends it` : ""}`,
          data: { playerId, expiration, comment, ...(tookOver ? { endedGroupHold: true } : {}) },
        });
        applied.push({ serverId: server.id, serverName: server.name, expiration: row.expiration });
      } catch (err) {
        if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") skipped.push({ serverId: server.id, serverName: server.name, reason: "observe mode (read-only)" });
        else skipped.push({ serverId: server.id, serverName: server.name, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `VIP not applied: ${skipped.map((s) => `${s.serverName} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped });
  }),

  /**
   * VIP for MANY players at once — the Live view's multi-select ("give everyone online a day"),
   * with an optional message sent to each player right after THEIR grant lands, so {vip_until} /
   * {vip_remaining} read the time they now have. Grant rules are the group grant's: a paid
   * permanent VIP in the selection is never shortened (kept, and the receipt says so), a paused one
   * banks the time without reappearing in game, and another game's id is skipped with the reason.
   * Messages are paced and retried once; one that still fails is reported per player — the VIP
   * stands either way.
   *
   * A list uploaded from a file (`upload: true`) gives each player their own end — `until`, a date
   * or null for permanent — and may give each their own comment, the one the downloaded list
   * carried; the same rules hold, so a list can only ever add VIP or lengthen it.
   */
  route("POST", "/api/servers/:id/vips/bulk", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    // Required (kit.ts requiredVipComment) — and checked before the permission: without it, the
    // refusal files the call as a request, and one filed without a comment could never be signed
    // into a grant. It is the note of every VIP this creates, and in the VIP history of every
    // player it reaches; a player who already had VIP keeps their own note — a paid grant's
    // "bought 30 days" is not replaced because the selection they were in got a day.
    const comment = requiredVipComment(body.comment);
    if (!can(p.grants, "vip.grant", "write", { serverId: id })) return sendForbidden(res, "vip.grant", "write");
    const message = boundedText(body.message, TEXT_MAX.reason, "message");
    if (message && !can(p.grants, "action.message", "write", { serverId: id })) return sendForbidden(res, "action.message", "write");
    const rawPlayers = Array.isArray(body.players) ? body.players : [];
    const seen = new Set<string>();
    const upload = body.upload === true;
    const targets = rawPlayers
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        return {
          playerId: str(r.playerId).trim(), playerName: str(r.playerName) || null,
          ...(upload && "until" in r ? { until: r.until === null ? null : str(r.until) } : {}),
          ...(upload && str(r.comment).trim() ? { comment: boundedText(r.comment, TEXT_MAX.note, "comment") } : {}),
        };
      })
      .filter((x) => x.playerId)
      // Once each: a stacking grant run twice for one player gives them the time twice. One pass:
      // the list is the client's, as long as the body allows, and this runs before the cap below
      // can refuse it — the pairwise check this replaced was quadratic in that length.
      .filter((x) => {
        if (seen.has(x.playerId)) return false;
        seen.add(x.playerId);
        return true;
      });
    if (!targets.length) return sendError(res, 400, "players is required: [{ playerId, playerName? }, …]");
    if (targets.length > 200) return sendError(res, 400, "too many players in one call (max 200)");
    // Every player in an uploaded list carries their own end: one left without it would fall back
    // to the call's own mode, which the list never chose.
    if (upload && targets.some((t) => !("until" in t))) return sendError(res, 400, "every player in an uploaded list needs an until: a date, or null for permanent");
    try { computeGrantExpiration(body, null); } catch (err) { return sendError(res, 400, (err as Error).message); }
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const signedMessage = message ? signedText(await signerFor(ctx, "message", p), message, "message") : "";

    const applied: { playerId: string; playerName: string | null; note: string; messaged: boolean | null }[] = [];
    const skipped: { playerId: string; playerName: string | null; reason: string }[] = [];
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      // Fresh per player: each message follows that player's own grant, which a batch-wide VIP
      // list read before the first grant would not include.
      const renderer = message ? rendererFor(ctx.repo, server, client, { vipPerPlayer: true }) : null;
      for (const t of targets) {
        const idRefusal = await crossGameIdError(ctx.repo, server, t.playerId);
        if (idRefusal) { skipped.push({ ...t, reason: idRefusal }); continue; }
        // The grant this player gets: the call's own, or the one their line of the list carries.
        const wanted: Record<string, unknown> = "until" in t ? { mode: t.until === null ? "permanent" : "until", expiresAt: t.until ?? undefined } : body;
        const via = upload ? "from an uploaded list" : `bulk, ${targets.length} selected`;
        try {
          let existing = await ctx.repo.vips.get(id, t.playerId);
          let note: string | null = null;
          const heldNote = (row: VipRow) => `holds ${heldBy(row.groupHold!)} — added to the VIP they get back on leaving (${Math.round(row.groupHold!.bankedMs / 3_600_000)}h banked)`;
          const auditHeld = (row: VipRow | null, hold: NonNullable<VipRow["groupHold"]>) => ctx.repo.audit.create({
            actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
            targetType: "player", targetId: t.playerId, targetName: t.playerName ?? undefined, serverId: id,
            summary: `granted VIP to ${t.playerName || t.playerId} on ${server.name} (${via}) — ${row ? heldNote(row) : `holds ${heldBy(hold)} — kept`}`,
            data: { playerId: t.playerId, groupHeld: true, ...(row ? { bankedMs: hold.bankedMs } : {}), comment, bulk: true, ...(upload ? { upload: true } : {}) },
          });
          if (existing?.groupHold) {
            // A group perk holds their VIP permanent: time joins the balance they get back on
            // leaving; a permanent grant aimed at a selection leaves the group's hold as it is.
            const held = grantForHeld(wanted);
            if (held.kind === "permanent") {
              note = `holds ${heldBy(existing.groupHold)} — kept`;
              await auditHeld(null, existing.groupHold);
            } else {
              const basis = await bankIfHeld(ctx.repo, id, t.playerId, held.change);
              if (basis.banked) {
                note = heldNote(basis.banked);
                await auditHeld(basis.banked, basis.banked.groupHold!);
              } else {
                existing = basis.existing; // the hold ended between the read and the bank: granted below
              }
            }
          }
          if (note === null) {
            const expiration = neverShorter(existing, computeGrantExpiration(wanted, existing));
            const vipPaused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
            if (!vipPaused) await client.execute("addVip", { playerId: t.playerId, description: t.playerName || comment });
            // No replacePermanent: aimed at a selection, not at one member's standing grant.
            const row = await ctx.repo.vips.upsert({ serverId: id, playerId: t.playerId, playerName: t.playerName, comment: existing ? null : ("comment" in t && t.comment ? t.comment : comment), expiration, createdByUserId: p.user.id, createdByName: p.name });
            if (row.groupHold) {
              // A hold that began after the read: a dated grant went to its frozen balance, a
              // permanent one left it as it is.
              note = expiration ? heldNote(row) : `holds ${heldBy(row.groupHold)} — kept`;
              await auditHeld(expiration ? row : null, row.groupHold);
            } else {
              // Kept either way it happens: stacking onto permanent absorbs before the write, a set
              // length (or one granted permanent since the read) is refused by the store's floor —
              // both leave a permanent VIP exactly as it was.
              const keptPermanent = row.expiration === null && (existing?.expiration === null || expiration !== null);
              note = row.expiration ? `until ${row.expiration}` : keptPermanent ? "already permanent — kept" : "permanent";
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
                targetType: "player", targetId: t.playerId, targetName: t.playerName ?? undefined, serverId: id,
                summary: `granted VIP to ${t.playerName || t.playerId} on ${server.name} (${via}) — ${note}`,
                data: { playerId: t.playerId, expiration: row.expiration, comment, bulk: true, ...(upload ? { upload: true } : {}), ...(keptPermanent ? { keptPermanent: true } : {}) },
              });
            }
          }
          let messaged: boolean | null = null;
          if (renderer) {
            const sent = await renderer.render(signedMessage, t);
            try {
              await sendPlayerMessage(client, t.playerId, sent);
              messaged = true;
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "player.message",
                targetType: "player", targetId: t.playerId, targetName: t.playerName ?? undefined, serverId: id,
                summary: `messaged ${t.playerName || t.playerId} after a bulk VIP grant — ${sent.slice(0, 120)}`,
                data: { playerId: t.playerId, message: sent, ...(sent !== message ? { template: message } : {}), bulk: true },
              });
            } catch { messaged = false; }
            await pauseMs(MESSAGE_PACE_MS);
          }
          applied.push({ ...t, note: note ?? "", messaged });
        } catch (err) {
          if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") { skipped.push({ ...t, reason: "observe mode (read-only)" }); continue; }
          skipped.push({ ...t, reason: (err as Error).message });
        }
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
    if (!applied.length) return sendError(res, 409, `VIP not applied: ${skipped.map((s) => `${s.playerName || s.playerId} (${s.reason})`).join("; ").slice(0, 400)}`);
    sendJson(res, 200, { applied, skipped, messageFailed: applied.filter((a) => a.messaged === false).length });
  }),

  // Revoke VIP: remove it from the game and delete our expiry row. `?allServers=1` revokes everywhere.
  route("DELETE", "/api/servers/:id/vips/:playerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const allServers = q.get("allServers") === "1";
    const base = await ctx.repo.servers.findById(id);
    if (!base) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, base)) return sendError(res, 404, "server not found");
    const playerId = params.playerId!;
    /*
     * Capture and ask, like the grant next door. `vipRevoke` was an approvable KIND the executor
     * has always been able to run and nothing could ever produce: taking VIP away was the one half
     * of the pair that dead-ended in a 403 instead of becoming a request, so "please pull this
     * donor's VIP, it expired months ago" had no way to be asked. A DELETE carries its options in
     * the query string, hence `?draft=1` rather than a body flag.
     */
    if (!allServers) {
      /*
       * What the person signing would be ENDING. A permanent grant is very often a paid one, and the
       * line used to carry the id and nothing else — "Revoke VIP 7656119…", no name, no word of what
       * it took away. So it carries who, and the grant as it stands now (the executor refuses one
       * that turns permanent before anybody signs). One a group perk holds is never filed: what a
       * signed revoke runs ends the grant, and this one is the group's while they stay. It is
       * refused here rather than filed for somebody to sign into a failure — and a person who holds
       * the key removes the VIP of the player's own beneath the hold instead, below.
       */
      const standing = await ctx.repo.vips.get(id, playerId);
      if (standing?.groupHold && (q.get("draft") === "1" || !can(p.grants, "vip.revoke", "write", { serverId: id }))) {
        return sendError(res, 409, `they hold ${heldBy(standing.groupHold)} — remove them from the group to end it`);
      }
      const vipLine = () => ({
        serverId: id, capability: "vip.revoke", kind: "vipRevoke",
        payload: { playerId, ...(standing ? { grant: { expiration: standing.expiration, comment: standing.comment } } : {}) },
        playerId, playerName: standing?.playerName ?? null,
      });
      if (q.get("draft") === "1") return sendJson(res, 202, await captureLine(ctx, p, vipLine()));
      if (!can(p.grants, "vip.revoke", "write", { serverId: id })) {
        const filed = await fileRequest(ctx, p, [vipLine()]);
        void postApprovalCard(ctx, filed.id);
        return sendJson(res, 202, { requested: true, requestId: filed.id });
      }
    }
    if (!(allServers ? canAnywhere(p.grants, "vip.revoke", "write") : can(p.grants, "vip.revoke", "write", { serverId: id }))) return sendForbidden(res, "vip.revoke", "write");
    const all = await ctx.repo.servers.list();
    const targets = allServers ? all.filter((s) => can(p.grants, "vip.revoke", "write", { serverId: s.id })) : [base];
    const applied: string[] = [];
    const skipped: { serverName: string; reason: string }[] = [];
    /** Servers where the revoke took the VIP of their own from beneath a group's hold. */
    const held: { serverId: string; serverName: string; removedMs: number; heldBy: string }[] = [];

    for (const server of targets) {
      /*
       * A grant a group perk holds is two things: the group's permanent VIP, which lasts as long as
       * they stay listed — taken here, the perk would only hand it straight back — and the VIP of
       * their own frozen beneath it, which comes back when they leave. A revoke takes the second:
       * the balance empties, the hold stands, and nothing changes on the game, where the group
       * keeps them VIP. With nothing of their own beneath it there is nothing to revoke.
       */
      const standing = await ctx.repo.vips.get(server.id, playerId);
      if (standing?.groupHold) {
        const cut = await ctx.repo.vips.cutGroupHold(server.id, playerId, { all: true });
        if (!cut) { skipped.push({ serverName: server.name, reason: "their VIP changed while this ran — a group no longer holds it; look again before revoking" }); continue; }
        const by = heldBy(cut.row.groupHold ?? standing.groupHold);
        if (cut.removedMs <= 0) { skipped.push({ serverName: server.name, reason: `they hold ${by} and have no VIP of their own beneath it — remove them from the group to end it` }); continue; }
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.revoke",
          targetType: "player", targetId: playerId, targetName: standing.playerName ?? undefined, serverId: server.id,
          summary: `revoked ${standing.playerName || playerId}'s own VIP on ${server.name} — ${Math.round(cut.removedMs / 3_600_000)}h that would have come back on leaving their group; they keep ${by} while listed`,
          data: { playerId, groupHeld: true, removedMs: cut.removedMs, bankedMs: 0 },
        });
        applied.push(server.id);
        held.push({ serverId: server.id, serverName: server.name, removedMs: cut.removedMs, heldBy: by });
        continue;
      }
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        await client.execute("removeVip", { playerId });
        await ctx.repo.vips.remove(server.id, playerId);
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.revoke",
          targetType: "player", targetId: playerId, serverId: server.id,
          summary: `revoked VIP from ${playerId} on ${server.name}`, data: { playerId },
        });
        applied.push(server.id);
      } catch (err) {
        if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") skipped.push({ serverName: server.name, reason: "observe mode (read-only)" });
        else skipped.push({ serverName: server.name, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `VIP not revoked: ${skipped.map((s) => `${s.serverName} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped, held });
  }),

  /**
   * Subtract time from a VIP grant — the Add calculator run in reverse.
   *
   * A refund ("they charged back the donation, take the month back") used to mean staff reading
   * the current expiry, doing calendar arithmetic by hand, and re-granting with mode "until" —
   * exactly the error-prone math the Add presets exist to avoid. This takes the same days/hours
   * and moves the expiry DOWN instead of up.
   *
   * The expiry is panel-owned state (the game only knows permanent entries), so while time
   * remains this touches nothing but our row. Only when the subtraction uses the grant up does
   * the game hear RemoveVip — at that point it IS a revoke, and it behaves like one: row deleted,
   * not left behind at a past date for the sweep to trip over.
   *
   * Gated on vip.revoke, not vip.grant: taking time away is the removal power in smaller units,
   * and a partial removal must never be a path around lacking it.
   */
  route("POST", "/api/servers/:id/vips/reduce", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const body = await readJsonBody(req);
    if (!(body.allServers ? canAnywhere(p.grants, "vip.revoke", "write") : can(p.grants, "vip.revoke", "write", { serverId: id }))) return sendForbidden(res, "vip.revoke", "write");
    const base = await ctx.repo.servers.findById(id);
    if (!base) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, base)) return sendError(res, 404, "server not found");
    const playerId = str(body.playerId).trim();
    if (!playerId) return sendError(res, 400, "playerId is required");
    const days = Number(body.days ?? 0);
    const hours = Number(body.hours ?? 0);
    const cutMs = (days * 24 + hours) * 3_600_000;
    if (!(cutMs > 0)) return sendError(res, 400, "a positive days/hours to remove is required");
    const cutLabel = [days ? `${days}d` : "", hours ? `${hours}h` : ""].filter(Boolean).join(" ");

    const all = await ctx.repo.servers.list();
    const targets = body.allServers ? all.filter((s) => can(p.grants, "vip.revoke", "write", { serverId: s.id })) : [base];
    const applied: { serverId: string; serverName: string; expiration: string | null; removed: boolean; held?: { bankedMs: number; heldBy: string } }[] = [];
    const skipped: { serverId: string; serverName: string; reason: string }[] = [];

    for (const server of targets) {
      const existing = await ctx.repo.vips.get(server.id, playerId);
      // Each skip names the fact about the grant that stopped it — the response is the receipt
      // staff read to see what the refund actually reached.
      if (!existing) { skipped.push({ serverId: server.id, serverName: server.name, reason: "no VIP grant on this server" }); continue; }
      // Under a group perk's hold the group's permanent VIP stands while they are listed; the time
      // comes off the VIP of their own frozen beneath it — what they get back on leaving.
      if (existing.groupHold) {
        const cut = await ctx.repo.vips.cutGroupHold(server.id, playerId, { cutMs });
        if (!cut) { skipped.push({ serverId: server.id, serverName: server.name, reason: "their VIP changed while this ran — a group no longer holds it; look again before removing time" }); continue; }
        const by = heldBy(cut.row.groupHold ?? existing.groupHold);
        if (cut.removedMs <= 0) { skipped.push({ serverId: server.id, serverName: server.name, reason: `they hold ${by} and have no VIP of their own beneath it to take time from` }); continue; }
        const left = cut.row.groupHold?.bankedMs ?? 0;
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.reduce",
          targetType: "player", targetId: playerId, targetName: existing.playerName ?? undefined, serverId: server.id,
          summary: `removed ${cut.removedMs < cutMs ? `${Math.round(cut.removedMs / 3_600_000)}h (all there was, of ${cutLabel} asked)` : cutLabel} of ${existing.playerName || playerId}'s own VIP on ${server.name} — the time that comes back on leaving their group, ${Math.round(left / 3_600_000)}h left; they keep ${by} while listed`,
          data: { playerId, groupHeld: true, removedDays: days, removedHours: hours, removedMs: cut.removedMs, bankedMs: left },
        });
        applied.push({ serverId: server.id, serverName: server.name, expiration: null, removed: false, held: { bankedMs: left, heldBy: by } });
        continue;
      }
      if (existing.expiration === null) { skipped.push({ serverId: server.id, serverName: server.name, reason: "permanent VIP has no time to subtract — revoke it instead" }); continue; }
      // A banked pause FREEZES the meter: the stored expiration stops meaning "when it ends"
      // until resume adds the paused time back. So a frozen grant is never "already expired"
      // (the expiry sweep skips it for the same reason), and a reduction on one only moves the
      // stored date — the row survives even if the date lands in the past, exactly as it would
      // had the date passed while frozen. Resume settles it; the sweep collects it if it is
      // still past then. Deleting a frozen row here would eat the banked time.
      const frozen = Boolean(existing.pauseMode === "banked" && existing.pausedUntil);
      if (!frozen && Date.parse(existing.expiration) <= Date.now()) { skipped.push({ serverId: server.id, serverName: server.name, reason: "already expired" }); continue; }
      const newExp = Date.parse(existing.expiration) - cutMs;
      const usedUp = !frozen && newExp <= Date.now();
      // A paused VIP is already off the game — the pause did the RemoveVip. Telling the game
      // again would just error on some protocols; the row is ours either way.
      const vipPaused = Boolean(existing.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
      const client = gameClientFor(server);
      try {
        if (usedUp) {
          if (!vipPaused) {
            await connectGameClient(client, server);
            await client.execute("removeVip", { playerId });
          }
          // Only the dated, unheld grant read above goes. Telling the game is a round trip, and a
          // grant made permanent (or taken into a group's hold) meanwhile has no time to subtract,
          // the same as one that was permanent to begin with: it keeps its row, and its game entry.
          if (!(await ctx.repo.vips.removeTimed(server.id, playerId))) {
            const now = await ctx.repo.vips.get(server.id, playerId);
            if (now && !vipPaused) await client.execute("addVip", { playerId, description: now.playerName || existing.playerName || "VIP" }).catch(() => {});
            skipped.push({ serverId: server.id, serverName: server.name, reason: now ? "their VIP changed while this ran — it is now permanent or held by a group, and was left as it is" : "their VIP was removed while this ran" });
            continue;
          }
        } else {
          // Time remains: the game's entry stands, only our expiry moves. upsert keeps the
          // original creator and (via COALESCE) the stored name/comment. mayShorten: this is the
          // one write that moves a dated grant earlier on purpose — a person removing time.
          await ctx.repo.vips.upsert({ serverId: server.id, playerId, expiration: new Date(newExp).toISOString(), createdByUserId: p.user.id, createdByName: p.name, mayShorten: true });
        }
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "vip.reduce",
          targetType: "player", targetId: playerId, targetName: existing.playerName ?? undefined, serverId: server.id,
          summary: `removed ${cutLabel} of VIP time from ${existing.playerName || playerId} on ${server.name} (${usedUp ? "grant used up — VIP removed" : `now until ${new Date(newExp).toISOString()}`})`,
          data: { playerId, removedDays: days, removedHours: hours, before: existing.expiration, after: usedUp ? null : new Date(newExp).toISOString(), removed: usedUp },
        });
        applied.push({ serverId: server.id, serverName: server.name, expiration: usedUp ? null : new Date(newExp).toISOString(), removed: usedUp });
      } catch (err) {
        if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") skipped.push({ serverId: server.id, serverName: server.name, reason: "observe mode (read-only)" });
        else skipped.push({ serverId: server.id, serverName: server.name, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    if (!applied.length && skipped.length) return sendError(res, 409, `VIP time not removed: ${skipped.map((s) => `${s.serverName} (${s.reason})`).join("; ")}`);
    sendJson(res, 200, { applied, skipped });
  }),

  /**
   * Compare this server's LIVE VIP list against the grants table — and, on request, repair it.
   *
   * This is the staff-driven face of the worker's vip reconciler, born from a live incident: the
   * game answered a well-formed empty `vipplayers` list while the table held dozens of unexpired
   * grants — every VIP silently priorityless, nothing anywhere able to see it. The worker sweep
   * reports (and applies only when armed); this route is for the moment staff are LOOKING at the
   * problem and want it fixed now, with the plan in front of them.
   *
   * Without `apply` it only reads: the plan comes back as counts + rows and nothing is written.
   * With `apply: true` it executes the plan and then RE-READS the list, reporting before/after
   * counts — if the getter is lying (AddVip answering 200 while the list stays empty), the
   * response says so instead of celebrating.
   */
  route("POST", "/api/servers/:id/vips/reconcile", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const apply = body.apply === true;
    // Reading the plan is a read; executing it grants and revokes. Removals additionally need
    // vip.revoke — entries are skipped with the reason rather than failing the whole apply.
    if (!can(p.grants, "vip.grant", apply ? "write" : "read", { serverId: id })) return sendForbidden(res, "vip.grant", apply ? "write" : "read");
    // Reading the plan stays open (reads always do); EXECUTING it is a write like any other.
    if (apply && await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (apply && server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const mayRevoke = can(p.grants, "vip.revoke", "write", { serverId: id });

    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const before = normalizeGameVips(await client.execute("getVipIds"));
      if (before === null) return sendError(res, 409, "this server's protocol does not answer a structured VIP list, so there is nothing to compare against");
      const grants = await ctx.repo.vips.list(id);
      const plan = planVipReconcile(grants, before, new Date().toISOString());

      const summary = {
        onGame: before.length, grants: grants.length,
        apply: plan.apply.map((v) => ({ playerId: v.playerId, playerName: v.playerName, expiration: v.expiration })),
        remove: plan.remove, foreign: plan.foreign,
      };
      if (!apply) return sendJson(res, 200, { serverId: id, applied: false, ...summary });

      const restored: string[] = [];
      const removed: string[] = [];
      const skipped: { playerId: string; reason: string }[] = [];
      for (const v of plan.apply) {
        // The one guard the panel path also runs: an id from the other game's namespace would be
        // accepted and match nobody — the exact silent failure this route exists to end.
        const idRefusal = await crossGameIdError(ctx.repo, server, v.playerId);
        if (idRefusal) { skipped.push({ playerId: v.playerId, reason: idRefusal }); continue; }
        try {
          await client.execute("addVip", { playerId: v.playerId, description: v.playerName || v.comment || "VIP" });
          restored.push(v.playerId);
        } catch (err) {
          skipped.push({ playerId: v.playerId, reason: (err as Error).message });
        }
      }
      for (const r of plan.remove) {
        if (!mayRevoke) { skipped.push({ playerId: r.playerId, reason: `grant is ${r.why}, but you do not have vip.revoke here` }); continue; }
        try {
          await client.execute("removeVip", { playerId: r.playerId });
          removed.push(r.playerId);
        } catch (err) {
          skipped.push({ playerId: r.playerId, reason: (err as Error).message });
        }
      }

      // Read back rather than trust: the incident this route repairs was invisible precisely
      // because writes answered 200. If the count did not move, say so.
      const after = normalizeGameVips(await client.execute("getVipIds").catch(() => null));
      const verified = after !== null;
      // Net of the run's own removals: restoring 1 while removing 2 legitimately shrinks the
      // list, and comparing against the raw before-count would cry wolf on a healthy sync.
      const stuck = verified && restored.length > 0 && after.length <= before.length - removed.length;

      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "vips.reconcile",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `synced the VIP list on ${server.name}: restored ${restored.length}, removed ${removed.length}, skipped ${skipped.length} — game list ${before.length} → ${after?.length ?? "?"} of ${grants.length} grant(s)${plan.foreign.length ? `; ${plan.foreign.length} foreign entr${plan.foreign.length === 1 ? "y" : "ies"} left untouched` : ""}`,
        data: { restored, removed, skipped, foreign: plan.foreign, before: before.length, after: after?.length ?? null },
      });
      sendJson(res, 200, {
        serverId: id, applied: true, restored, removed, skipped, foreign: plan.foreign,
        before: before.length, after: after?.length ?? null,
        ...(stuck ? { warning: "the writes were accepted but the server's VIP list did not grow — the ids being restored may not be ones this server can act on. Check them against the live roster." } : {}),
      });
    } catch (err) {
      throw errors.upstream(`could not reconcile VIPs: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  /**
   * Compare this server's LIVE ban lists against the ban record — and, on request, repair them.
   *
   * The staff-driven face of the worker's ban reconciler, added the day the VIP twin earned its
   * keep: the Vietnam server dropped its whole VIP list in launch week, and ban lists live in the
   * same server state. Until then the only way to replay standing decisions onto a server that
   * lost them was arming the worker's reconciler to fix what it finds (now the "Fix what it
   * finds" switch under the server's Ban reconciliation automation); this is the same plan, run
   * once, with a human reading it first.
   *
   * Same contract as the VIP route: no `apply` → the plan as data, nothing written. `apply: true`
   * → execute and RE-READ the lists, reporting before/after counts, because a ban pushed under an
   * id the server cannot act on answers 200 and enforces nothing — the count not moving is the
   * only visible symptom.
   */
  route("POST", "/api/servers/:id/bans/reconcile", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    const body = await readJsonBody(req);
    const apply = body.apply === true;
    if (!can(p.grants, "moderation.bans.sync", apply ? "write" : "read", { serverId: id })) return sendForbidden(res, "moderation.bans.sync", apply ? "write" : "read");
    // Reading the plan stays open (reads always do); EXECUTING it is a write like any other.
    if (apply && await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (apply && server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");

    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const readLists = async () => {
        const [temp, perma] = await Promise.all([client.execute("getTempBans"), client.execute("getPermaBans")]);
        return [...normalizeGameBans(temp, "temp"), ...normalizeGameBans(perma, "perma")];
      };
      const before = await readLists();
      const decisions = await ctx.repo.playerBans.list();
      // The game's own placement time and duration ride along: a temp ban it still lists after its
      // time ran out is not one it enforces, and the planner leaves it alone (gameBanRanOut).
      const plan = planBanReconcile(id, server.game, decisions, before.map((b) => ({ playerId: b.playerId, type: b.type, ts: b.ts, durationHours: b.durationHours })), new Date().toISOString());
      // Who each id is, for every line that names a player: the game's own list first, then the record.
      const nameOf = new Map<string, string>();
      for (const d of decisions) if (d.playerName) nameOf.set(d.playerId, d.playerName);
      for (const b of before) if (b.playerName) nameOf.set(b.playerId, b.playerName);
      const named = (playerId: string) => ({ playerId, playerName: nameOf.get(playerId) ?? null });

      const summary = {
        onGame: before.length,
        apply: plan.apply.map((d) => ({ playerId: d.playerId, playerName: d.playerName, kind: d.kind, reason: d.reason, expiresAt: d.expiresAt })),
        lift: plan.lift, foreign: plan.foreign,
        ranOut: plan.ranOut.map((r) => named(r.playerId)),
      };
      if (!apply) return sendJson(res, 200, { serverId: id, applied: false, ...summary });

      const restored: string[] = [];
      const lifted: string[] = [];
      const skipped: { playerId: string; playerName: string | null; reason: string }[] = [];
      // Stored reasons are what staff typed; placeholders fill for each player on THIS server.
      let banRenderer: MessageRenderer | null = null;
      for (const d of plan.apply) {
        // A decision stored under an id this game cannot act on would be accepted and enforce
        // nothing — the exact silent failure this route exists to end. Skipped with the fix named.
        const idRefusal = await crossGameIdError(ctx.repo, server, d.playerId);
        if (idRefusal) { skipped.push({ ...named(d.playerId), reason: idRefusal }); continue; }
        try {
          const reason = await (banRenderer ??= rendererFor(ctx.repo, server, client)).render(d.reason, { playerId: d.playerId, playerName: d.playerName });
          if (d.kind === "perma") {
            await client.execute("permaBanPlayer", { playerId: d.playerId, reason, adminName: p.name });
          } else {
            // Hours from the decision's remaining time — the game takes a duration, the record
            // keeps a date (same arithmetic as the worker sweep).
            const hours = d.expiresAt ? Math.max(1, Math.ceil((Date.parse(d.expiresAt) - Date.now()) / 3_600_000)) : 1;
            await client.execute("tempBanPlayer", { playerId: d.playerId, reason, hours, adminName: p.name });
          }
          restored.push(d.playerId);
        } catch (err) {
          skipped.push({ ...named(d.playerId), reason: (err as Error).message });
        }
      }
      for (const l of plan.lift) {
        try {
          await client.execute(l.kind === "perma" ? "removePermaBan" : "removeTempBan", { playerId: l.playerId });
          lifted.push(l.playerId);
        } catch (err) {
          skipped.push({ ...named(l.playerId), reason: (err as Error).message });
        }
      }

      const after = await readLists().catch(() => null);
      const stuck = after !== null && restored.length > 0 && after.length <= before.length - lifted.length;

      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "bans.reconcile",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `synced the ban list on ${server.name}: applied ${restored.length} standing ban(s), lifted ${lifted.length}, skipped ${skipped.length} — game list ${before.length} → ${after?.length ?? "?"}${plan.foreign.length ? `; ${plan.foreign.length} ban(s) placed outside the panel left untouched` : ""}${plan.ranOut.length ? `; ${plan.ranOut.length} temp ban(s) it still lists had already run out, left as they are` : ""}`,
        data: { restored, lifted, skipped, foreign: plan.foreign, ranOut: summary.ranOut, before: before.length, after: after?.length ?? null },
      });
      sendJson(res, 200, {
        serverId: id, applied: true, restored, lifted, skipped, foreign: plan.foreign, ranOut: summary.ranOut,
        before: before.length, after: after?.length ?? null,
        ...(stuck ? { warning: "the writes were accepted but the server's ban list did not grow — the decisions being applied may carry ids this server cannot act on. Check them against the live list's own ids (Bans → Live)." } : {}),
      });
    } catch (err) {
      throw errors.upstream(`could not reconcile bans: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // --- Server config editor ---
  // Read the current settings. Each getter is read independently and tolerated (→ null on error),
  // so one unsupported field never fails the whole read. maxQueuedPlayers comes off the session.
  serverRoute("GET", "/api/servers/:id/config", "server.config", "read", async ({ res, ctx, id, server }) => {

    const client = gameClientFor(server);
    const config: Record<string, unknown> = {};
    try {
      await connectGameClient(client, server);
      for (const f of configFieldsFor(server.game).values()) {
        if (!f.read) continue;
        try { config[f.field] = extractConfigValue(await client.execute(f.read.command), f.read.key); }
        catch { config[f.field] = null; } // unsupported on this protocol/server
      }
      try {
        const session = await client.readState("session") as Record<string, unknown> | null;
        if (session) config.maxQueuedPlayers = session.maxQueueCount ?? null;
      } catch { /* session read optional */ }
      // Which of these values Auto settings is actively HOLDING (live, not dry-run): the drift
      // pass re-applies the active profile's settings, so a hand edit to one of those fields is
      // rewritten within a pass — the page must say so up front, not let staff discover the
      // fight the way the field discovered the map-vote one. Name + fields only, no schedule
      // details: this page's capability is server.config, not autosettings.profiles.
      let managed: { profile: string; fields: string[] } | null = null;
      try {
        const auto = await ctx.repo.autosettings.getConfig(id);
        if (auto?.enabled && !auto.dryRun && auto.profiles.length > 0) {
          const snap = await ctx.repo.rosterSnapshots.latest(id).catch(() => null);
          // The match clock too, or a "first ten minutes" profile never reads as the holder here
          // and the banner names whichever profile sits below it.
          const openMatch = await ctx.repo.matches.getOpen(id).catch(() => null);
          const profiles = auto.profiles.map((p) => (p.spec && !p.spec.timezone ? { ...p, spec: { ...p.spec, timezone: auto.timezone } } : p));
          const active = resolveProfile(profiles as { name: string; spec?: ScheduleSpec }[], new Date(), {
            playerCount: snap?.playerCount ?? null,
            alliedCount: snap?.composition?.bySide?.["allies"]?.players ?? null,
            axisCount: snap?.composition?.bySide?.["axis"]?.players ?? null,
            matchMinutes: matchMinutesSince(openMatch?.startedAt, Date.now()),
          });
          const fields = active ? Object.keys(auto.profiles.find((p) => p.name === active.name)?.settings ?? {}) : [];
          if (active && fields.length) managed = { profile: active.name, fields };
        }
      } catch { /* advisory only — the settings themselves already loaded */ }
      sendJson(res, 200, { serverId: id, config, managed });
    } catch (err) {
      throw errors.upstream(`could not read config: ${(err as Error).message}`, { serverId: id, host: server.host, port: server.port });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // Change one or more settings. Body keys are the CONFIG_WRITE fields; only those present are set.
  // Writes → refused on observe (409). Each change is applied and audited individually.
  serverRoute("POST", "/api/servers/:id/config", "server.config", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const fields = configFieldsFor(server.game);
    const changes = Object.keys(body).filter((k) => fields.get(k)?.write);
    if (!changes.length) return sendError(res, 400, `no known settings to change. Known: ${[...fields.keys()].join(", ")}`);
    // The live welcome message owns the game's welcome text while it is on — a hand-set text would
    // be overwritten at its next pass, or worse, silently kept until the fill changes.
    if (changes.includes("welcomeMessage") && (await ctx.repo.welcome.getConfig(id))?.enabled) {
      return sendError(res, 409, "the live welcome message is on for this server — change the text under Broadcast → Live welcome message, or switch it off there first");
    }

    const client = gameClientFor(server);
    const applied: string[] = [];
    try {
      await connectGameClient(client, server);
      for (const field of changes) {
        const spec = fields.get(field)!;
        const raw = body[field];
        let value = spec.kind === "num" ? Number(raw) : spec.kind === "bool" ? Boolean(raw) : str(raw);
        // The welcome/notice message may carry the signature system's second line (the Discord
        // invite / appeals note), switched on under Administration → Signatures. Appended HERE so
        // the audit row and the game agree on what players actually read; the staff half never
        // applies to a standing setting (appendWelcomeSignature enforces that).
        if (field === "welcomeMessage" && typeof value === "string") {
          value = appendWelcomeSignature(await ctx.repo.signatures.get(), value);
        }
        await client.execute(spec.write!.command, { [spec.write!.param]: value });
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "config.set",
          targetType: "server", targetId: id, targetName: server.name, serverId: id,
          summary: `set ${field} = ${value} on ${server.name}`, data: { field, value },
        });
        applied.push(field);
      }
      sendJson(res, 200, { applied });
    } catch (err) {
      if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") return sendError(res, 409, (err as Error).message);
      throw errors.upstream(`config change failed: ${(err as Error).message}`, { serverId: id, applied });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),
];
