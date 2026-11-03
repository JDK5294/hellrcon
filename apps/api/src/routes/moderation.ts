/**
 * Bans — the record of who may not play, and the seed that adopts what the game already enforces.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { sendJson } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { connectGameClient, gameClientFor, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import { normalizeGameBans } from "@app/rcon-core";
import { resolveBanScope, type BanScope } from "../ban-scope.js";

export const moderationRoutes: Route[] = [
  /**
   * The community's ban record — the player_ban decisions, active first.
   *
   * This used to be a derivation: the last 500 audit entries OF ANY KIND filtered to ban actions,
   * unioned with the CRCON import. A busy week of kicks and VIP grants pushed real bans off the end
   * of that window and they silently vanished from the page — the imported rows kept it looking
   * populated, which is why nobody noticed. The decisions table has no window, and one row here is
   * one decision, however many servers its rule covers.
   *
   * NOT a live read of the game's ban list — that stays GET /servers/:id/bans, and comparing the
   * two is the reconciler's job.
   */
  route("GET", "/api/bans", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.bans", "read")) return sendForbidden(res, "moderation.bans", "read");
    const u = new URL(req.url ?? "", "http://x");
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const includeLifted = u.searchParams.get("history") === "1";
    const [rows, servers] = await Promise.all([
      ctx.repo.playerBans.list(includeLifted ? {} : { activeOnly: true }),
      ctx.repo.servers.list(),
    ]);
    const now = new Date().toISOString();
    // Bans synced off the game arrive nameless (the game's list is ids), but the DIRECTORY often
    // knows exactly who an id is — fill the gaps from it, so the book reads as people, not hex.
    // The same read answers which platform each banned player is on, for the Platform column: the
    // token the game reported, or the ingest placeholder until it has. An id the panel has never
    // seen has no row, and no platform to claim.
    const directory = new Map((await ctx.repo.players.findByPlatformIds([...new Set(rows.map((b) => b.playerId))])).map((pl) => [pl.platformId, pl]));
    const nameless = new Set(rows.filter((b) => !b.playerName).map((b) => b.playerId));
    const directoryName = new Map([...directory].filter(([id]) => nameless.has(id)).map(([id, pl]) => [id, pl.name]));
    const bans = rows
      // Per-row scope enforcement: a per-server moderator sees a decision if its rule covers any
      // server they may read. A rule that currently resolves to nothing (say, "only" a server
      // since deleted) is visible to anyone with the page — hiding it would strand it forever.
      .filter((b) => {
        const covered = resolveBanScope(b.scope as BanScope, servers, b.game);
        return covered.length === 0 || covered.some((sv) => can(p.grants, "moderation.bans", "read", { serverId: sv.id }));
      })
      // The covered servers' names are searchable too — "nam" finds the bans that reach Nam — so
      // the record can be read one server at a time without knowing the filter exists.
      .filter((b) => !q || [
        b.playerName, directoryName.get(b.playerId), b.playerId, b.reason, b.category, b.createdByName,
        ...resolveBanScope(b.scope as BanScope, servers, b.game).map((sv) => sv.name),
      ].some((f) => (f ?? "").toLowerCase().includes(q)))
      .map((b) => ({
        id: b.id, ts: b.createdAt, by: b.createdByName, playerName: b.playerName || directoryName.get(b.playerId) || null, playerId: b.playerId,
        platform: directory.get(b.playerId)?.platform || null,
        type: b.kind, reason: b.reason, category: b.category, scope: b.scope, game: b.game,
        expiresAt: b.expiresAt, liftedAt: b.liftedAt, liftedBy: b.liftedByName,
        active: b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now),
        auto: b.createdByName === "enforcer",
        // Which servers the rule covers TODAY, for display. The rule itself travels too, because
        // "these two" and "all (which is two today)" must not render identically.
        serverIds: resolveBanScope(b.scope as BanScope, servers, b.game).map((sv) => sv.id),
      }));
    sendJson(res, 200, { bans });
  }),

  /**
   * Seed the decisions table from the game servers' own ban lists.
   *
   * The bootstrap for a community that has been banning people since before this table existed —
   * and the recovery path if the table is ever lost. The game is the source of truth here on
   * purpose: it needs no interpretation, and it does not care which tool wrote the ban.
   *
   * Safe to re-run: a (game, player, kind) that already has an ACTIVE decision is skipped, so
   * running it twice cannot duplicate, and running it after new panel bans cannot double them.
   *
   * The one inference: a player banned on EVERY server of a game almost certainly means "banned
   * from the community", so those collapse to {mode:"all"} and are counted out loud in the
   * response. Anything less than every server stays a literal server list — exactly what we know.
   */
  route("POST", "/api/bans/seed", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.bans.sync", "write")) return sendForbidden(res, "moderation.bans.sync", "write");

    /*
     * A seed both READS a server's ban list and WRITES decisions covering that server, so it may
     * only visit the servers this signer actually holds the capability on. `moderation.bans.sync`
     * is a scoped capability: holding it on one server is not authority over the rest, and the
     * anywhere check above is only the cheap early refusal. Same shape as the group-apply route —
     * gate wide, then narrow the targets to what the grants really cover.
     */
    const allServers = await ctx.repo.servers.list();
    const servers = allServers.filter((s) => can(p.grants, "moderation.bans.sync", "write", { serverId: s.id }));
    if (servers.length === 0) return sendForbidden(res, "moderation.bans.sync", "write");
    const outOfScope = allServers.filter((s) => !servers.some((x) => x.id === s.id));
    const perServer: { serverId: string; serverName: string; ok: boolean; error?: string; temp: number; perma: number }[] = [];
    /** (game, playerId, kind) → the servers holding it + the first-seen ban details. */
    const found = new Map<string, { game: string; playerId: string; kind: "temp" | "perma"; serverIds: string[]; playerName: string | null; reason: string; by: string | null; ts: string | null; durationHours: number }>();

    for (const server of servers) {
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        const [temp, perma] = await Promise.all([client.execute("getTempBans"), client.execute("getPermaBans")]);
        const rows = [...normalizeGameBans(temp, "temp"), ...normalizeGameBans(perma, "perma")];
        for (const b of rows) {
          if (!b.playerId) continue;
          const key = `${server.game}|${b.playerId}|${b.type}`;
          const cur = found.get(key);
          if (cur) cur.serverIds.push(server.id);
          else found.set(key, { game: server.game, playerId: b.playerId, kind: b.type, serverIds: [server.id], playerName: b.playerName, reason: b.reason || "(from the game's ban list)", by: b.by, ts: b.ts, durationHours: b.durationHours });
        }
        perServer.push({ serverId: server.id, serverName: server.name, ok: true, temp: normalizeGameBans(temp, "temp").length, perma: normalizeGameBans(perma, "perma").length });
      } catch (err) {
        // A server that cannot be read is reported, not skipped silently — a seed that quietly
        // missed one server would under-collapse every community-wide ban.
        perServer.push({ serverId: server.id, serverName: server.name, ok: false, error: (err as Error).message, temp: 0, perma: 0 });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }

    // Counted over EVERY server of the game, not just the ones seeded: "this ban is everywhere"
    // may only collapse to an all-servers rule when the seed actually read every server of that
    // game. A signer who read two of three must not write a decision covering the third.
    const serversOfGame = new Map<string, number>();
    for (const sv of allServers) serversOfGame.set(sv.game, (serversOfGame.get(sv.game) ?? 0) + 1);
    // Dedupe against every UNLIFTED decision, not just unexpired ones: a temp ban whose computed
    // expiry has lapsed while the game still lists it is a clock disagreement with the game, and
    // re-recording it on every run would multiply the row without changing anything.
    const existing = (await ctx.repo.playerBans.list()).filter((b) => b.liftedAt === null);
    const has = new Set(existing.map((b) => `${b.game}|${b.playerId}|${b.kind}`));

    let created = 0, collapsed = 0, skippedExisting = 0;
    for (const [key, f] of found) {
      if (has.has(key)) { skippedExisting++; continue; }
      const total = serversOfGame.get(f.game) ?? 0;
      const everywhere = total > 1 && f.serverIds.length === total;
      if (everywhere) collapsed++;
      // A game temp ban knows when it was placed and for how long; the decision keeps the date.
      const expiresAt = f.kind === "temp" && f.ts && f.durationHours > 0
        ? new Date(Date.parse(f.ts) + f.durationHours * 3_600_000).toISOString()
        : null;
      await ctx.repo.playerBans.create({
        game: f.game, playerId: f.playerId, playerName: f.playerName, kind: f.kind,
        reason: f.reason, scope: everywhere ? { mode: "all" } : { mode: "servers", serverIds: f.serverIds },
        expiresAt, createdByName: f.by || "(game ban list)",
        // The game's own timestamp when it has one — never the seed clock.
        createdAt: f.ts && !Number.isNaN(Date.parse(f.ts)) ? new Date(Date.parse(f.ts)).toISOString() : undefined,
      });
      created++;
    }

    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "bans.seed", targetType: "system", targetId: "bans",
      summary: `seeded the ban record from ${perServer.filter((x) => x.ok).length} server(s): ${created} decision(s), ${collapsed} collapsed to all-servers, ${skippedExisting} already recorded${perServer.some((x) => !x.ok) ? ` — ${perServer.filter((x) => !x.ok).length} server(s) unreachable` : ""}${outOfScope.length ? ` — ${outOfScope.length} server(s) outside this account's ban-sync rights` : ""}`,
      data: { created, collapsed, skippedExisting, outOfScope: outOfScope.map((s) => s.id) },
    });
    // The servers this account may not seed are NAMED rather than silently absent: a seed that
    // covered half the community and reported a clean run would read as "the record is complete".
    sendJson(res, 200, {
      created, collapsed, skippedExisting, servers: perServer,
      outOfScope: outOfScope.map((s) => ({ serverId: s.id, serverName: s.name })),
    });
  }),

];
