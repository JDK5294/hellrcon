/**
 * Admin camera: the in-game notification switch, and the record of who was in spectator.
 *
 * Spectator is the one staff power with no target and no audit row — nobody is kicked, nothing is
 * written down, and the only trace is a line in the game log that scrolls away and gets trimmed.
 * That makes it the power most worth keeping a record of, so the pairing is stored in its own
 * table (built by the ingest) and read back here.
 *
 * Two capabilities, deliberately different. Reading the history is `server.admins` READ — the same
 * grant that lets you see who holds in-game admin at all, because this is a fact about those
 * people. Changing whether players are told is `server.admins` WRITE: it changes what happens on
 * the server, not just what staff can see.
 */
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { ADMIN_CAM_DEFAULTS, ADMIN_CAM_SORTS, serverWideTextError } from "@app/db";
import type { AdminCamSort } from "@app/db";
import { getGame } from "@app/games";
import { connectGameClient, gameClientFor, pageLimit, pageOffset, requirePrincipal, route, sendForbidden, serverRoute, type Route } from "./kit.js";

/** The longest an announcement may be. The game truncates silently past a few hundred characters,
 *  and a message nobody can read to the end is worse than a shorter one. */
const MAX_MESSAGE = 300;

export const adminCamRoutes: Route[] = [
  serverRoute("GET", "/api/servers/:id/admincam/config", "server.admins", "read", async ({ res, ctx, id }) => {
    const cfg = await ctx.repo.adminCam.getConfig(id);
    // An unset server answers with the defaults rather than null, so the editor has something to
    // render and "never configured" and "configured to the defaults" look the same — which they are.
    sendJson(res, 200, { serverId: id, ...ADMIN_CAM_DEFAULTS, ...(cfg ?? {}) });
  }),

  serverRoute("PUT", "/api/servers/:id/admincam/config", "server.admins", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const patch: { notifyEnabled?: boolean; enterMessage?: string; exitMessage?: string } = {};
    if (body.notifyEnabled !== undefined) patch.notifyEnabled = body.notifyEnabled === true;
    for (const k of ["enterMessage", "exitMessage"] as const) {
      if (body[k] === undefined) continue;
      const v = str(body[k]).trim();
      if (v.length > MAX_MESSAGE) return sendError(res, 400, `${k} must be ${MAX_MESSAGE} characters or fewer`);
      patch[k] = v;
    }
    // Both messages blank with the switch on would be a toggle that does nothing, silently. Say so.
    const merged = { ...ADMIN_CAM_DEFAULTS, ...(await ctx.repo.adminCam.getConfig(id) ?? {}), ...patch };
    if (merged.notifyEnabled && !merged.enterMessage.trim() && !merged.exitMessage.trim()) {
      return sendError(res, 400, "with notifications on, at least one of the two messages needs text");
    }
    // The notice is a broadcast to everyone; {player} is the admin (filled from the camera line),
    // but a per-player placeholder like {player_name} has no one to fill it for.
    if (merged.notifyEnabled) {
      for (const k of ["enterMessage", "exitMessage"] as const) {
        const bad = serverWideTextError(merged[k], "the admin-camera notice");
        if (bad) return sendError(res, 400, bad);
      }
    }
    const cfg = await ctx.repo.adminCam.setConfig(id, patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "admincam.config",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `turned admin-camera notifications ${cfg.notifyEnabled ? "on" : "off"} for ${server.name}`,
      data: { notifyEnabled: cfg.notifyEnabled },
    });
    sendJson(res, 200, cfg);
  }),

  /**
   * Where the admin-camera record breaks, answered from the server itself.
   *
   * This subsystem's only failure mode is silence. A camera visit leaves one line in the admin log
   * and nothing else; if any link in the chain — the game emitting it, the poll reading it, the
   * parser recognising it, the pairing storing it — drops that line, the page shows an empty table
   * and there is nothing anywhere that says why. We have twice now gone looking for the cause by
   * reading our own source and reasoning about what the game probably prints, which is exactly the
   * guessing this endpoint exists to end.
   *
   * So it walks the chain and reports each link with its evidence: what the switch is set to, what
   * the server just returned, which of those lines look like camera lines AT ALL (a deliberately
   * loose match, so a line we cannot parse still shows up as raw text), what our parser made of
   * each one, and what is actually in the two tables. Whichever link is the first to come back
   * empty is the answer.
   *
   * `server.admins` READ, the same grant as the history it is diagnosing. It runs a read command;
   * it changes nothing, and it works in observe mode.
   */
  serverRoute("GET", "/api/servers/:id/admincam/selfcheck", "server.admins", "read", async ({ req, res, ctx, id, server }) => {
    const u = new URL(req.url ?? "", "http://x").searchParams;
    // Default to an hour: long enough that a visit from earlier in the round is still in the
    // window, short enough that the game answers quickly.
    const seconds = Math.min(Math.max(Number(u.get("seconds")) || 3600, 60), 6 * 3600);
    const since = new Date(Date.now() - seconds * 1000).toISOString();

    const cfg = await ctx.repo.adminCam.getConfig(id);
    const notify = { ...ADMIN_CAM_DEFAULTS, ...(cfg ?? {}) };

    // Anything mentioning a camera, however it is spelled. The point is to separate "the game
    // never said it" from "it said it and we could not read it" — so this must NOT be the parser's
    // own pattern, or the two failures would look identical.
    const looksLikeCamera = (line: string) => /camera|spectat/i.test(line);

    const mod = getGame(server.game);
    const client = gameClientFor(server);
    let read: { ok: true; lines: number; camera: { raw: string; parsed: { name: string | null; playerId: string | null; entered: boolean | null } | null }[] }
      | { ok: false; error: string };
    try {
      await connectGameClient(client, server);
      const lines = await client.readLogLines(seconds);
      const camera = lines.filter(looksLikeCamera).slice(0, 25).map((raw) => {
        const evt = mod?.normalizeLine(raw, { serverId: id }) ?? null;
        const parsed = evt && evt.kind === "evt.admin.camera"
          ? {
              name: (evt as { playerName?: string }).playerName ?? null,
              playerId: (evt as { playerId?: string }).playerId ?? null,
              entered: ((evt.data as { entered?: boolean | null } | null)?.entered) ?? null,
            }
          : null;
        return { raw, parsed };
      });
      read = { ok: true, lines: lines.length, camera };
    } catch (err) {
      // A failed read is itself a finding — the worker is hitting the same wall — so it is
      // reported rather than thrown.
      read = { ok: false, error: (err as Error).message };
    } finally {
      await client.disconnect().catch(() => {});
    }

    const [storedEvents, sampleEvents, visits] = await Promise.all([
      ctx.repo.events.countQuery({ serverId: id, kinds: ["evt.admin.camera"], from: since }),
      ctx.repo.events.query({ serverId: id, kinds: ["evt.admin.camera"], from: since, limit: 10 }),
      ctx.repo.adminCam.count({ serverId: id }),
    ]);

    sendJson(res, 200, {
      serverId: id, serverName: server.name, game: server.game, seconds, since,
      engagementMode: server.engagementMode,
      notify: { enabled: notify.notifyEnabled, enterMessage: notify.enterMessage, exitMessage: notify.exitMessage },
      read,
      stored: {
        events: storedEvents,
        visits,
        sample: sampleEvents.map((e) => ({
          ts: e.ts, actorName: e.actorName,
          entered: ((e.data as { entered?: boolean | null } | null)?.entered) ?? null,
        })),
      },
    });
  }),

  /**
   * The history, across every server the viewer may see.
   *
   * Community-wide by default rather than per-server: "was anybody in cam last night" is a question
   * about the community, and a page that could only answer it one server at a time would make you
   * ask it once per server. `serverId` narrows it, and the scope is always clamped to what the
   * viewer's grants actually cover.
   *
   * Sorting is a query parameter, not something the page does to the rows it received. The list is
   * paged, and sorting one page by duration answers "the longest visit on this page", which is not
   * the question anybody is asking.
   */
  route("GET", "/api/admincam/history", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.admins", "read")) return sendForbidden(res, "server.admins", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    // The real id list, not serverScope's "undefined means everything": this page needs the ids
    // themselves for its server dropdown and for the list of admins to offer.
    const allowed = (await ctx.repo.servers.list({ includeRetired: true })) // cam HISTORY outlives a retirement
      .filter((s) => can(p.grants, "server.admins", "read", { serverId: s.id }))
      .map((s) => s.id);
    const requested = u.get("serverId") || undefined;
    if (requested && !allowed.includes(requested)) return sendForbidden(res, "server.admins", "read");
    const sortRaw = u.get("sort") ?? "";
    const query = {
      ...(requested ? { serverId: requested } : { serverIds: allowed }),
      playerId: u.get("playerId") || undefined,
      q: u.get("q")?.trim() || undefined,
      limit: pageLimit(u, 50, 200),
      offset: pageOffset(u),
      sort: (ADMIN_CAM_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as AdminCamSort) : "entered",
      dir: u.get("dir") === "asc" ? ("asc" as const) : ("desc" as const),
    };
    const [sessions, total, admins, servers] = await Promise.all([
      ctx.repo.adminCam.list(query),
      ctx.repo.adminCam.count(query),
      ctx.repo.adminCam.admins(allowed),
      ctx.repo.servers.list({ includeRetired: true }), // labels old sessions
    ]);
    // The server's NAME, resolved here: the table is sorted by it server-side, so the page must not
    // be left to look it up and disagree about the order.
    const nameById = new Map(servers.map((s) => [s.id, s.name]));
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({ ...s, serverName: nameById.get(s.serverId) ?? s.serverId })),
      total, offset: query.offset, limit: query.limit,
      // The two filter dropdowns, filled from what the record actually contains rather than from
      // the whole staff list — you can only have been in cam if you were in cam.
      admins,
      servers: allowed.map((id) => ({ id, name: nameById.get(id) ?? id })),
    });
  }),
];
