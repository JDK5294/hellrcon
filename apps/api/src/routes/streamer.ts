/**
 * The unauthenticated CRCON-compatible surface — streamer mode / the public stats API.
 *
 * Two mounts, one contract:
 *   /stats/<publicSlug>/api/<crcon_command>  — the human address. The same base URL serves the
 *       public stats PAGE (/stats/<slug>) and the API its overlay tools call, so the link a
 *       streamer pastes into a tool is the link a player pastes into a browser.
 *   /s/<serverId>/api/<crcon_command>        — the original mount, kept as an alias so nobody's
 *       configured tool breaks. Same handler, same rules.
 *
 * **Every handler in this file is reachable by anyone on the internet.** The invariants:
 *   - the server must exist AND have streamerMode on, else 404 (never "403 turn it on" — an
 *     anonymous caller learns nothing about servers they were not given the address for);
 *   - the command must be in the ENDPOINTS whitelist;
 *   - reads only, and only the fields CRCON itself publishes. Nothing we hold and CRCON does not
 *     (IPs, watchlist reasons, notes, audit, Discord identity, VIP status) is served here.
 *
 * See docs/streamer-mode.md for the verified contract and docs/public-stats.md for the
 * scoreboard endpoints' field mapping and deliberate divergences.
 *
 * ---------------------------------------------------------------------------------------------
 * Portions derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool:
 *   how its public API views answer (rconweb/api), quirks included.
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { normalizeSession } from "@app/rcon-core";
import { classifyWeapon, getGame, weaponClassesOf } from "@app/games";
import { buildMatchReport, publicMatchReport } from "../match-report.js";
import { PUBLIC_LOG_KINDS, PUBLIC_LOG_LIMIT, publicMatchLog } from "../public-log.js";
import { sendJson } from "../http.js";
import { pyBigInt, pyDumps, pyFloat, pyIntArgument } from "../crcon-json.js";
import { DJANGO_400, DJANGO_500, DJANGO_HTML, crconArgs, pgInt4 } from "../crcon-http.js";
import { crconFiledRows, crconLiveGameStats, crconLiveScoreboard, type CrconLiveResult } from "../crcon-live.js";
import { clientAddrOf } from "../rate-limit.js";
import { normalizeHost } from "../public-host.js";
import {
  ENDPOINTS, IMPLEMENTED, PublicRateLimiter, buildLayer, buildMapHistory,
  buildPreviousMap, buildPublicInfo, buildScoreboardListRow, buildScoreboardMap, buildScoreboardMaps,
  buildVoteStatus, crconConfigComplete, crconIsImported, envelope, mapHistoryEntries, type MapHistoryEntry,
} from "../streamer.js";
import { connectGameClient, gameClientFor, logger, route, type Route } from "./kit.js";
import type { AppContext } from "../context.js";
import type { ClassKillRecord, CrconRoundRow, MatchRow, MatchStatRecord, ServerRow } from "@app/db";

/**
 * `version` in every envelope, and `get_version`'s answer: CRCON's TAG_VERSION, which is
 * f"v{version('hll-rcon-tool')}" (rconweb/settings.py). These mounts answer byte for byte as the
 * release named here does, so this is the release a tool is talking to as far as the wire goes.
 * It moves only together with the parity work, never on its own.
 */
const VERSION = "v12.3.0";

/** Every answer on the CRCON mounts goes out in CRCON's own bytes (crcon-json.ts), with its
 *  content type: Django's HttpResponse says `application/json` and nothing more. */
function sendCrcon(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(pyDumps(body));
}

/** Where CRCON's stack answers with a Django page (or Django's empty 405), the same bytes here. */
function sendDjango(res: import("node:http").ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": DJANGO_HTML, "cache-control": "no-store", ...headers });
  res.end(body);
}

/** Postgres' bigint ceiling (LIMIT and OFFSET), and orjson's ceiling for an int it will write. */
const INT8_MAX = 9223372036854775807n;
const UINT64_MAX = 18446744073709551615n;

const limiter = new PublicRateLimiter();

/**
 * One shared live read per server per few seconds.
 *
 * This is a public endpoint: without collapsing, N streamers plus their viewers' overlays would
 * each open an RCON session against the game server. The panel's own /live route does the same
 * thing for the same reason; this cache is separate only because it must never be reachable by an
 * unauthenticated caller through the authenticated path.
 */
const LIVE_MS = 5000;
interface LiveRead {
  session: ReturnType<typeof normalizeSession>;
  /** The roster; null when the game did not answer the read. */
  roster: Record<string, unknown>[] | null;
  /** The rotation as the game reports it, for the next-map slot. Null when it cannot be read. */
  rotation: { currentIndex?: number; mAPS?: { iD?: string; name?: string }[] } | null;
  /** GetServerInformation("serverconfig") — build, platforms, password. Null when it was not read:
   *  a legacy or bridged server has no such read, and a v2 server's read can fail. */
  config: Record<string, unknown> | null;
}
const liveCache = new Map<string, { at: number; read: Promise<LiveRead> }>();

function readLive(server: ServerRow): Promise<LiveRead> {
  const hit = liveCache.get(server.id);
  if (hit && Date.now() - hit.at < LIVE_MS) return hit.read;
  const read = (async () => {
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      // Four reads down one connection, and only the session is required here. What a failed
      // read of the others means is each endpoint's to say, as CRCON's view would say it: the
      // next map is spared a failed rotation read, get_public_info fails without a v2 server's
      // config, and the live board without its roster.
      const [rawSession, players, rawRotation, rawConfig] = await Promise.all([
        client.readState("session"),
        // public_info works without a roster and the live board does not, so a failed read is kept
        // apart from an answer.
        client.readState("players").then((value) => ({ value }), () => null),
        client.readState("maprotation").catch(() => null), // next_map only
        client.execute("getServerConfig").catch(() => null), // the config block only
      ]);
      const rawPlayers = players?.value;
      const roster = players === null
        ? null
        : Array.isArray(rawPlayers)
          ? (rawPlayers as Record<string, unknown>[])
          : Array.isArray((rawPlayers as { players?: unknown[] })?.players)
            ? ((rawPlayers as { players: unknown[] }).players as Record<string, unknown>[])
            : [];
      return {
        session: normalizeSession(rawSession),
        roster,
        rotation: (rawRotation ?? null) as LiveRead["rotation"],
        config: (rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : null),
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  })();
  liveCache.set(server.id, { at: Date.now(), read });
  read.catch(() => liveCache.delete(server.id)); // a failed read must not be served to the next caller
  return read;
}

/** refresh_interval_sec on the live scoreboards: how often ours are worked out (LIVE_MS). */
const LIVE_REFRESH_SEC = Math.round(LIVE_MS / 1000);
const liveBoardCache = new Map<string, LiveSnapshotEntry>();
const liveGameCache = new Map<string, LiveSnapshotEntry>();
interface LiveSnapshotEntry { at: number; read: Promise<CrconLiveResult | null>; good: CrconLiveResult | null }

/**
 * One live scoreboard per server per LIVE_MS. A pass that fails falls back to the last one that
 * worked (CRCON serves its cache until its loop next writes it); null means there never was one.
 */
function liveSnapshot(cache: Map<string, LiveSnapshotEntry>, serverId: string, compute: () => Promise<CrconLiveResult>): Promise<CrconLiveResult | null> {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < LIVE_MS) return hit.read;
  const entry: LiveSnapshotEntry = { at: Date.now(), read: Promise.resolve(null), good: hit?.good ?? null };
  entry.read = compute().then((r) => { entry.good = r; return r; }).catch((err: unknown) => {
    logger.warn("live scoreboard pass failed; serving the last one", { serverId, err });
    return entry.good;
  });
  cache.set(serverId, entry);
  return entry.read;
}

/**
 * The map after the current one, from the rotation the game reports.
 *
 * CRCON reads its own `next_map` from the gamestate; the v2 protocol does not report one, so this
 * takes the same route the panel and the Discord board already do — the entry after `currentIndex`,
 * wrapping at the end. That answer stays correct when a map vote schedules its winner, because a
 * scheduled winner IS placed into that slot.
 */
function nextMapFrom(rotation: LiveRead["rotation"]): string {
  const maps = Array.isArray(rotation?.mAPS) ? rotation.mAPS : [];
  if (!maps.length) return "";
  const entry = maps[((rotation?.currentIndex ?? 0) + 1) % maps.length];
  // `iD`, NOT `name`. A rotation entry carries both: `name` is the shouted display string
  // ("SAINTE-MÈRE-ÉGLISE OFFENSIVE") and `iD` is the layer id ("stmereeglise_offensive_us").
  // buildLayer parses the id's grammar, so handing it the display name would produce a layer whose
  // mode, environment and attackers were all wrong — the Discord board reads `name` because it is
  // printing a caption, which is the opposite need.
  return String(entry?.iD ?? entry?.name ?? "");
}

/** Epoch seconds, or null. Matches expose ISO strings; CRCON's history is epoch. */
const epoch = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** CRCON's map history for a server: its newest 500 rounds (MapsHistory's max_len), newest first,
 *  the short ones our own records drop included — CRCON's history has every round it saw start. */
async function mapHistory(ctx: AppContext, server: ServerRow, limit: number): Promise<MapHistoryEntry[]> {
  const rows = await ctx.repo.matches.crconRounds(server.id, limit, 0);
  return mapHistoryEntries(rows, server.game);
}

/**
 * A filed round's rows (crcon-live.ts crconFiledRows), cached briefly. A filed round is near
 * immutable, but every anonymous hit would otherwise re-read its whole log and re-run CRCON's
 * statistics over it. A short TTL rather than forever because late writes do exist (an import
 * touching the same round); bounded so link-spraying old map_ids cannot grow it. Keyed with the
 * server's id switch, so flipping it never serves the other kind of row.
 */
const FINISHED_MS = 60_000;
const FINISHED_MAX = 50;
const filedCache = new Map<string, { at: number; read: Promise<Record<string, unknown>[]> }>();
function filedRows(ctx: AppContext, server: ServerRow, round: CrconRoundRow, newer: CrconRoundRow | null): Promise<Record<string, unknown>[]> {
  const key = `${round.seq}|${newer?.seq ?? ""}|${server.publicPlayerIds ? 1 : 0}`;
  const hit = filedCache.get(key);
  if (hit && Date.now() - hit.at < FINISHED_MS) return hit.read;
  const read = crconFiledRows(ctx, server, round, newer);
  if (filedCache.size >= FINISHED_MAX) {
    const oldest = filedCache.keys().next().value;
    if (oldest !== undefined) filedCache.delete(oldest);
  }
  filedCache.set(key, { at: Date.now(), read });
  read.catch(() => filedCache.delete(key));
  return read;
}

/**
 * The round REPORT's assembly, cached on the scoreboard's own terms. It is the heaviest fold on
 * the public surface — stat rows plus up to 20k kill events per build — and it ran per request:
 * a finished round's report re-folded for every holder of a shared link, and the live page POLLS
 * report/current, so N viewers cost N folds every interval. One promise per round now; a finished
 * round rides the finished TTL, the open one the live TTL, and the `live` flag on the entry makes
 * the whistle refold immediately instead of serving the last live fold for a finished minute.
 */
/**
 * A round by its public integer alias on this server, or `current` for the round in play. Null for
 * a missing, foreign or unparseable id: the alias is install-wide, and another server's round must
 * answer exactly like a missing one so this address never becomes a window into unpublished servers.
 */
async function publicRoundOf(ctx: AppContext, server: ServerRow, id: string | undefined): Promise<MatchRow | null> {
  let match: MatchRow | null = null;
  if (id === "current") {
    match = await ctx.repo.matches.getOpen(server.id).catch(() => null);
  } else {
    const seq = Math.trunc(Number(id));
    if (Number.isSafeInteger(seq) && seq > 0) match = await ctx.repo.matches.getBySeq(seq);
  }
  return match && match.serverId === server.id ? match : null;
}

/** The round's GAME LOG (public-log.ts), cached like the report: one read per round per TTL, the
 *  live round on the live TTL so the page polling it costs one query, not one per viewer. */
const logCache = new Map<string, { at: number; live: boolean; read: Promise<unknown> }>();
function publicLogOf(ctx: AppContext, match: MatchRow): Promise<unknown> {
  const live = !match.endedAt;
  const hit = logCache.get(match.id);
  if (hit && hit.live === live && Date.now() - hit.at < (live ? LIVE_MS : FINISHED_MS)) return hit.read;
  const read = (async () => {
    const events = await ctx.repo.events.window({
      serverId: match.serverId,
      kinds: [...PUBLIC_LOG_KINDS],
      from: match.startedAt,
      // The report's window: a second past the whistle rather than shave the closing kill.
      to: match.endedAt ? new Date(Date.parse(match.endedAt) + 1000).toISOString() : undefined,
      limit: PUBLIC_LOG_LIMIT,
    });
    return publicMatchLog(events, match.startedAt, match.endedAt, events.length >= PUBLIC_LOG_LIMIT);
  })();
  if (logCache.size >= REPORT_MAX) {
    const oldest = logCache.keys().next().value;
    if (oldest !== undefined) logCache.delete(oldest);
  }
  logCache.set(match.id, { at: Date.now(), live, read });
  read.catch(() => logCache.delete(match.id));
  return read;
}

const reportCache = new Map<string, { at: number; live: boolean; read: Promise<unknown> }>();
const REPORT_MAX = 50;
function publicReportOf(ctx: AppContext, server: ServerRow, match: MatchRow): Promise<unknown> {
  const live = !match.endedAt;
  const hit = reportCache.get(match.id);
  if (hit && hit.live === live && Date.now() - hit.at < (live ? LIVE_MS : FINISHED_MS)) return hit.read;
  const read = (async () => {
    const [stats, events, scoreSeries] = await Promise.all([
      ctx.repo.matches.statsForMatch(match.id),
      ctx.repo.events.window({
        serverId: match.serverId,
        kinds: ["evt.kill", "evt.teamkill"],
        from: match.startedAt,
        // Exclusive upper bound: pad a second past the whistle rather than shave the closing kill.
        to: match.endedAt ? new Date(Date.parse(match.endedAt) + 1000).toISOString() : undefined,
        limit: 20_000,
      }).catch(() => []),
      // The score charts are extra: a failed read leaves the rest of the report standing.
      ctx.repo.matches.scoreSeries(match.id).catch(() => new Map<string, number[]>()),
    ]);
    const descriptor = getGame(match.game ?? server.game)?.descriptor;
    const report = buildMatchReport({
      events, stats, startedAt: match.startedAt, endedAt: match.endedAt,
      classify: (w) => classifyWeapon(descriptor, w),
      scoreSeries,
    });
    // Names from the stat rows first, the stream as fallback — a player folded from kills alone
    // (no stat row) still publishes under the name the stream saw them wear.
    const names = new Map<string, string>();
    for (const e of events) {
      if (e.actorPlayerId && e.actorName) names.set(e.actorPlayerId, e.actorName);
      if (e.victimPlayerId && e.victimName) names.set(e.victimPlayerId, e.victimName);
    }
    for (const s of stats) if (s.playerName) names.set(s.playerId, s.playerName);
    return publicMatchReport(report, (id) => names.get(id) ?? null);
  })();
  if (reportCache.size >= REPORT_MAX) {
    const oldest = reportCache.keys().next().value;
    if (oldest !== undefined) reportCache.delete(oldest);
  }
  reportCache.set(match.id, { at: Date.now(), live, read });
  read.catch(() => reportCache.delete(match.id));
  return read;
}


/**
 * The one handler behind both mounts. `server` arrives resolved-and-authorized: it exists and has
 * streamerMode on (the callers below produce the uniform 404 otherwise).
 */
async function handleCommand(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  ctx: AppContext,
  server: ServerRow,
  command: string,
): Promise<void> {
  const send = (body: unknown, status = 200) => sendCrcon(res, status, body);
  // The arguments as CRCON's views read them. Null for a query Django refuses outright, which only
  // the three views that read their arguments meet, as Django's 400 page.
  const args = crconArgs(req.url ?? "/");

  if (!IMPLEMENTED.has(command)) {
    return send(envelope({ command, failed: true, error: "not implemented on this server", version: VERSION }), 501);
  }

  try {
    switch (command) {
      case "get_version":
        return send(envelope({ result: VERSION, command, version: VERSION }));

      case "get_public_info": {
        // Every read CRCON's view makes has to answer, or the view raises: the game state, the
        // server config, the map history and the vote's status. Only the next map is spared (its
        // gamestate reads "unknown" when the rotation cannot be had). A server with no config read
        // at all, legacy or bridged, is one CRCON v12.3.0 cannot run against; it answers without one.
        const [{ session, rotation, config }, newest, voteConfig, voteState] = await Promise.all([
          readLive(server),
          ctx.repo.matches.list(server.id, 1, 0),
          ctx.repo.mapVote.getConfig(server.id),
          ctx.repo.mapVote.getState(server.id),
        ]);
        if (server.protocol === "binary-v2" && !crconConfigComplete(config)) throw new Error("serverconfig unreadable");
        const game = server.game === "hllv" ? "hllv" : "hll";
        const latest = newest[0];
        const result = buildPublicInfo({
          game,
          serverName: session.serverName || server.gameName,
          shortName: server.publicName ?? "",
          currentMapId: session.mapId || session.mapName || "",
          // The rotation entry after the current one, wrapping, as CRCON's _get_next_map_id reads
          // it off the map sequence; "unknown" when there is no rotation to read.
          nextMapId: nextMapFrom(rotation) || "unknown",
          latest: latest
            ? { start: epoch(latest.startedAt), capFlips: latest.capFlips, moraleHistory: latest.moraleHistory, matchTime: latest.matchTime }
            : null,
          playerCount: session.playerCount ?? 0,
          maxPlayerCount: session.maxPlayerCount ?? 0,
          alliedPlayers: session.alliedPlayerCount ?? 0,
          axisPlayers: session.axisPlayerCount ?? 0,
          alliedScore: session.alliedScore ?? 0,
          axisScore: session.axisScore ?? 0,
          alliedMorale: session.alliedMorale ?? 0,
          axisMorale: session.axisMorale ?? 0,
          initialMorale: session.initialMorale ?? 0,
          timeRemainingSec: session.remainingMatchTime ?? 0,
          voteStatus: buildVoteStatus({
            enabled: Boolean(voteConfig?.enabled),
            paused: Boolean(voteState?.paused),
            options: voteState?.options ?? [],
            tallies: voteState?.tallies ?? [],
            overrideMapId: voteState?.overrideMapId ?? null,
            inPlayMapId: session.mapId || null,
            ingameVoters: voteState?.ingameVoters ?? null,
            activeMessageId: voteState?.activeMessageId ?? null,
            publishIds: server.publicPlayerIds,
            game,
          }),
          serverConfig: config as Parameters<typeof buildPublicInfo>[0]["serverConfig"],
        });
        return send(envelope({ result, command, version: VERSION }));
      }

      case "get_map_history": {
        if (!args) return sendDjango(res, 400, DJANGO_400);
        const history = await mapHistory(ctx, server, 500);
        // `if data.get("pretty")`: any value but an empty one, a repeated key's list included.
        return send(envelope({ result: buildMapHistory(history, Boolean(args.get("pretty"))), command, args: {}, version: VERSION }));
      }

      case "get_previous_map": {
        const history = await mapHistory(ctx, server, 2);
        return send(envelope({ result: buildPreviousMap(history), command, version: VERSION }));
      }

      /*
       * The two live scoreboards, as CRCON's caches hold them (crcon-live.ts): get_live_scoreboard
       * is LiveStats, everyone connected over their current session; get_live_game_stats is
       * TimeWindowStats, everyone the current round's log names. Each is worked out at most once
       * per LIVE_MS per server, and a pass that fails serves the last good one, as CRCON serves
       * whatever its cache last held — or, with none, its own answers for an empty cache.
       */
      case "get_live_scoreboard": {
        const snap = await liveSnapshot(liveBoardCache, server.id, async () => {
          const { roster } = await readLive(server);
          // CRCON's pass raises when the roster read does, and its last snapshot stands.
          if (!roster) throw new Error("roster read failed");
          return crconLiveScoreboard(ctx, server, roster, Date.now());
        });
        // CRCON's quirks, copied: the command echoes WITHOUT its get_ prefix, the success error is a
        // serialized Python one-tuple, and an empty cache answers failed with an empty error.
        if (!snap) return send(envelope({ result: {}, command: "live_scoreboard", failed: true, error: "", version: VERSION }));
        const result = { snapshot_timestamp: pyFloat(snap.snapshotMs / 1000), refresh_interval_sec: LIVE_REFRESH_SEC, stats: snap.stats };
        return send(envelope({ result, command: "live_scoreboard", error: [null], version: VERSION }));
      }
      case "get_live_game_stats": {
        const snap = await liveSnapshot(liveGameCache, server.id, () => crconLiveGameStats(ctx, server, Date.now()));
        // The dict CRCON's loop pickles, in its key order; nothing cached yet is a null result.
        const result = snap ? { snapshot_timestamp: pyFloat(snap.snapshotMs / 1000), stats: snap.stats, refresh_interval_sec: LIVE_REFRESH_SEC } : null;
        return send(envelope({ result, command, version: VERSION }));
      }

      case "get_scoreboard_maps": {
        /**
         * CRCON's lines (scoreboards.py): `page_size = min(int(data.get("limit", 100)), 1000)`,
         * `page = max(1, int(data.get("page", 1)))`, and the server_number filter. The key is
         * `limit` alone — CRCON ignores `page_size` on the way in. The view catches nothing, so
         * whatever refuses the request on the way answers with Django's server error page: Python's
         * int() (a repeated key is a list, which it refuses too), Postgres reading server_number as
         * an integer, a negative LIMIT or an OFFSET past bigint, and orjson writing a page number
         * past 64 bits. Python's ints have no ceiling, so the numbers are worked in bigints.
         */
        if (!args) return sendDjango(res, 400, DJANGO_400);
        const intArg = (v: string | string[] | undefined, absent: bigint): bigint | null =>
          v === undefined ? absent : typeof v === "string" ? pyBigInt(v) : null;
        const limit = intArg(args.get("limit"), 100n);
        const pageArg = intArg(args.get("page"), 1n);
        if (limit === null || pageArg === null) return sendDjango(res, 500, DJANGO_500);
        const pageSize = limit < 1000n ? limit : 1000n;
        const page = pageArg > 1n ? pageArg : 1n;
        const offset = (page - 1n) * pageSize;
        if (pageSize < 0n || offset > INT8_MAX || page > UINT64_MAX) return sendDjango(res, 500, DJANGO_500);
        const pageOut = page <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(page) : page;
        const servers = await ctx.repo.servers.list();
        // CRCON's server_number is which INSTALL answered; ours is the display ordinal staff see.
        const serverNumber = servers.findIndex((s) => s.id === server.id) + 1 || null;
        // `?server_number=` filters CRCON's table by it, as its Postgres reads the text against an
        // integer column; every round here is this server's.
        const asked = args.get("server_number");
        if (asked !== undefined) {
          const n = typeof asked === "string" ? pgInt4(asked) : null;
          if (n === null) return sendDjango(res, 500, DJANGO_500);
          if (n !== serverNumber) return send(envelope({ result: buildScoreboardMaps([], pageOut, Number(pageSize), 0), command, version: VERSION }));
        }
        // CRCON files a round's scoreboard as the NEXT round starts, so the newest round we
        // recorded is not listed yet (an imported one was filed by CRCON itself, and is). Each
        // listed round is read with the round that started after it, one row above it.
        const [[newest], count] = await Promise.all([
          ctx.repo.matches.crconRounds(server.id, 1, 0),
          ctx.repo.matches.crconRoundCount(server.id),
        ]);
        const skip = newest && !crconIsImported(newest) ? 1 : 0;
        // The first listed round's place among them all; a page past the last round reads nothing.
        const first = BigInt(skip) + offset < BigInt(count) ? skip + Number(offset) : count;
        const from = Math.max(0, first - 1);
        const rows = pageSize > 0n && first < count ? await ctx.repo.matches.crconRounds(server.id, Number(pageSize) + (first - from), from) : [];
        // Each round against the game IT was played on (CRCON's parse_recorded_layer).
        const maps = rows.slice(first - from).map((m, k) => {
          const newer = first + k > 0 ? rows[first - from + k - 1] : undefined;
          return buildScoreboardListRow(m, newer?.startedAt ?? null, m.game ?? server.game, serverNumber);
        });
        // No `arguments`: CRCON's get_scoreboard_maps passes none to api_response, so its envelope
        // carries null there.
        return send(envelope({ result: buildScoreboardMaps(maps, pageOut, Number(pageSize), Math.max(0, count - skip)), command, version: VERSION }));
      }

      /*
       * CRCON's get_map_scoreboard (scoreboards.py) echoes the request's own arguments, as sent:
       * every key in the order it came, a string, or the list of them for a key sent twice. And it
       * answers 200 whatever happened, failure included, with `failed` saying so: "No map for this
       * ID" for an id with no filed round, and the repr() of Python's exception for an id int()
       * refuses.
       */
      case "get_map_scoreboard": {
        if (!args) return sendDjango(res, 400, DJANGO_400);
        const id = pyIntArgument(args.get("map_id"));
        if ("error" in id) return send(envelope({ command, args, failed: true, error: id.error, version: VERSION }));
        // A round belonging to ANOTHER server answers exactly like a missing one: the alias is
        // install-wide, and this address must not become a window into servers that were never
        // published. And like CRCON, only a round whose scoreboard is filed — one with a round
        // after it — has one.
        const found = await ctx.repo.matches.crconRoundBySeq(server.id, id.value);
        if (!found || (!found.newer && !crconIsImported(found.round))) {
          return send(envelope({ command, args, failed: true, error: "No map for this ID", version: VERSION }));
        }
        const { round, newer } = found;
        const [stats, servers] = await Promise.all([
          filedRows(ctx, server, round, newer),
          ctx.repo.servers.list(),
        ]);
        const serverNumber = servers.findIndex((s) => s.id === server.id) + 1 || null;
        // PlayerStats.to_dict per filed row, each with the view's `encounters` on the end.
        return send(envelope({ result: buildScoreboardMap(round, newer?.startedAt ?? null, round.game ?? server.game, serverNumber, stats), command, args, version: VERSION }));
      }

      default:
        return send(envelope({ command, failed: true, error: "not implemented on this server", version: VERSION }), 501);
    }
  } catch (err) {
    // Public surface: log the detail, tell the caller only that it failed, in the shape CRCON's
    // view fails in. Three of them catch nothing, so a failure there is Django's server error page;
    // the rest answer their own envelope with `failed` set. (Their error text, a Python
    // exception's repr(), has no counterpart here.)
    logger.warn("streamer endpoint failed", { command, serverId: server.id, err });
    switch (command) {
      case "get_public_info":
      case "get_scoreboard_maps":
      case "get_map_history":
        return sendDjango(res, 500, DJANGO_500);
      case "get_live_scoreboard":
        return send(envelope({ result: {}, command: "live_scoreboard", failed: true, error: "", version: VERSION }));
      case "get_map_scoreboard":
        return send(envelope({ command, args, failed: true, error: "command failed", version: VERSION }));
      default:
        return send(envelope({ command, failed: true, error: "command failed", version: VERSION }));
    }
  }
}

/**
 * Any method but GET at a command on the CRCON mounts, as CRCON's stack answers it: a CORS
 * preflight is django-cors-headers' empty 200, and anything else at one of the commands is the
 * empty 405 of Django's require_http_methods(["GET"]), HEAD included. Neither looks the server up,
 * so both answer the same for every address and say nothing about which servers exist.
 */
export function crconNotGet(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, rawCommand: string): void {
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined) return sendDjango(res, 200, "");
  let command = rawCommand;
  try {
    command = decodeURIComponent(rawCommand);
  } catch {
    // Not a command name either way.
  }
  if (!Object.hasOwn(ENDPOINTS, command)) return sendCrcon(res, 404, envelope({ command, failed: true, error: "unknown command", version: VERSION }));
  return sendDjango(res, 405, "", { allow: "GET" });
}

/** The shared gate: whitelist, uniform 404, per-IP budget — identical for both mounts. */
async function gateAndHandle(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  ctx: AppContext,
  command: string,
  resolve: () => Promise<ServerRow | null>,
): Promise<void> {
  const send = (body: unknown, status = 200) => sendCrcon(res, status, body);

  // An unknown command is a 404 with the envelope still filled in, so a tool pointed at a
  // command we do not serve sees a parseable refusal rather than an HTML error page.
  const budget = Object.hasOwn(ENDPOINTS, command) ? ENDPOINTS[command] : undefined;
  if (!budget) return send(envelope({ command, failed: true, error: "unknown command", version: VERSION }), 404);

  const server = await resolve().catch(() => null);
  // Not found and not-enabled are deliberately the same answer. Distinguishing them would let an
  // anonymous caller probe which server ids or slugs exist.
  if (!server || !server.streamerMode) {
    return send(envelope({ command, failed: true, error: "not found", version: VERSION }), 404);
  }

  const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
  if (!limiter.allow(command, addr, budget.perMinute)) {
    res.setHeader("retry-after", "60");
    return send(envelope({ command, failed: true, error: "rate limited", version: VERSION }), 429);
  }

  return handleCommand(req, res, ctx, server, command);
}

export const streamerRoutes: Route[] = [
  route("GET", "/s/:serverId/api/:command", (req, res, ctx, params) =>
    gateAndHandle(req, res, ctx, params.command ?? "", () => ctx.repo.servers.findById(params.serverId ?? ""))),

  route("GET", "/stats/:slug/api/:command", (req, res, ctx, params) =>
    gateAndHandle(req, res, ctx, params.command ?? "", () => ctx.repo.servers.findBySlug(params.slug ?? ""))),

  /**
   * The stats site as a home-screen app: its own web app manifest, since the panel's starts at the
   * staff sign-in. `orientation: "any"` is what lets a saved stats page turn with the phone (with
   * no manifest the phone keeps it upright, as it kept the installed panel before the panel had
   * one). Served here rather than as a file because its address depends on the host it is opened
   * on: the whole dedicated public hostname is the stats site, while on the panel's host it is
   * /stats alone. Its name is the community's (PUBLIC_STATS_NAME), as the page's own header is.
   */
  route("GET", "/api/public/webmanifest", async (req, res, ctx) => {
    const wanted = normalizeHost(ctx.config.publicStatsHost);
    const base = wanted && normalizeHost(req.headers.host) === wanted ? "/" : "/stats";
    const site = ctx.config.publicStatsName;
    res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
    res.end(JSON.stringify({
      id: base,
      name: site ? `${site} Stats` : "Stats",
      short_name: site ?? "Stats",
      start_url: base,
      scope: base,
      display: "standalone",
      orientation: "any",
      background_color: "#0a0c10",
      theme_color: "#0a0c10",
    }));
  }),

  /**
   * The stats page's manifest: which servers are published, at what address, called what, and how
   * to READ them — side labels and score-bucket columns straight from each game's descriptor, so
   * the page renders US/NVA on a Vietnam server and Allies/Axis on WW2 without knowing either
   * game. Published servers only: a server that is not published does not exist here, same rule
   * as the API mounts. No live data — the page asks each server's own endpoints for that.
   */
  route("GET", "/api/public/servers", async (req, res, ctx) => {
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    if (!limiter.allow("public_servers", addr, 60)) {
      res.setHeader("retry-after", "60");
      return sendJson(res, 429, { error: "rate limited" });
    }
    const servers = (await ctx.repo.servers.list()).filter((s) => s.streamerMode && s.publicSlug);
    sendJson(res, 200, {
      // What the site calls itself in its own header. This page is handed to PLAYERS, so it should
      // wear the community's name, not the software's — set PUBLIC_STATS_NAME. Null means the page
      // falls back to the app name, which is at least not wrong, only impersonal.
      // `origin` is the address to hand out (PUBLIC_STATS_ORIGIN, or the public hostname): a link
      // copied from the page opened on the panel's host must carry it, never the admin hostname.
      // Null when no public hostname is set; the page then names its own address.
      site: { name: ctx.config.publicStatsName, origin: ctx.config.publicStatsOrigin ?? null },
      servers: servers.map((s) => {
        const d = getGame(s.game)?.descriptor;
        return {
          slug: s.publicSlug,
          // The one surface that keeps the game's real identity: players found this server by its
          // browser name. The staff alias rides beside it, quoted, when one is set.
          name: (s.publicName || s.gameName) + (s.nickname ? ` “${s.nickname}”` : ""),
          game: s.game,
          playerIds: s.publicPlayerIds,
          sides: (d?.sides ?? []).map((side) => ({ id: side.id, label: side.label, color: side.color })),
          scoreFields: (d?.scoreFields ?? []).map((f) => ({ key: f.key, label: f.label, title: f.title })),
          squadLabel: d?.squadLabel ?? "Squad",
        };
      }),
    });
  }),

  /**
   * The stats page's ROUND REPORT — the charts layer over a round's scoreboard: awards, the flow
   * timeline, the class split, duels, and each player's personal kill timeline.
   *
   * This is OUR endpoint, not CRCON's: the CRCON-compatible mounts above stay byte-for-byte, and
   * anything they never served rides beside them under /api/public like the manifest does. Same
   * anonymous-caller rules as everything on this file: published servers only, uniform 404, and
   * nothing but what the public scoreboard already shows — the report is built from the same kill
   * stream and re-keyed to display names, so no internal id ever crosses this wire (see
   * publicMatchReport). `:id` is the round's public integer alias, or `current` for the round in
   * play — which the live page polls, hence the tighter per-IP budget.
   */
  route("GET", "/api/public/:slug/report/:id", async (req, res, ctx, params) => {
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    if (!limiter.allow("public_report", addr, 30)) {
      res.setHeader("retry-after", "60");
      return sendJson(res, 429, { error: "rate limited" });
    }
    const server = await ctx.repo.servers.findBySlug(params.slug ?? "").catch(() => null);
    if (!server || !server.streamerMode) return sendJson(res, 404, { error: "not found" });
    const match = await publicRoundOf(ctx, server, params.id);
    if (!match) return sendJson(res, 404, { error: "not found" });
    sendJson(res, 200, { report: await publicReportOf(ctx, server, match) });
  }),

  /**
   * The round's GAME LOG — its start and end, every kill and team kill with the weapon, every
   * connect and disconnect, every team switch and admin camera entry and exit, in order
   * (public-log.ts). OUR endpoint, like the report: the CRCON mounts stay byte-for-byte. Names only
   * and no chat. `:id` is the round's public integer alias or `current`, which the live page polls.
   * Same gate as the report.
   */
  route("GET", "/api/public/:slug/log/:id", async (req, res, ctx, params) => {
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    if (!limiter.allow("public_log", addr, 30)) {
      res.setHeader("retry-after", "60");
      return sendJson(res, 429, { error: "rate limited" });
    }
    const server = await ctx.repo.servers.findBySlug(params.slug ?? "").catch(() => null);
    if (!server || !server.streamerMode) return sendJson(res, 404, { error: "not found" });
    const match = await publicRoundOf(ctx, server, params.id);
    if (!match) return sendJson(res, 404, { error: "not found" });
    sendJson(res, 200, { log: await publicLogOf(ctx, match) });
  }),

  /**
   * The public SERVER stats page — what this server is like to play on, from its own recorded
   * history: which maps run and who wins them, how rounds tend to end (contested / decisive /
   * stomp, with 2-2 counted as the crash it almost always is), how busy the last month was, the
   * single-round records worth arguing about, and the regulars who live here.
   *
   * Assembled from the matches table and the career rollups — no kill-stream folds, so the whole
   * page is a handful of indexed reads. Still, it walks up to SERVER_STATS_SCAN rounds, so the
   * result is cached in-process for a few minutes; a public page hammered by a Discord link must
   * not become a table scan per visitor. Names only on the wire, same rule as the report.
   */
  route("GET", "/api/public/:slug/stats", async (req, res, ctx, params) => {
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    if (!limiter.allow("public_server_stats", addr, 20)) {
      res.setHeader("retry-after", "60");
      return sendJson(res, 429, { error: "rate limited" });
    }
    const server = await ctx.repo.servers.findBySlug(params.slug ?? "").catch(() => null);
    if (!server || !server.streamerMode) return sendJson(res, 404, { error: "not found" });

    const hit = serverStatsCache.get(server.id);
    if (hit && Date.now() - hit.at < SERVER_STATS_TTL_MS) return sendJson(res, 200, hit.body as Record<string, unknown>);

    const [overrideRows, recKills, recCombat, recSupport, topPlaytime, topKills, counts] = await Promise.all([
      ctx.repo.mapNames.list(server.game).catch(() => []),
      ctx.repo.matches.topStats(server.id, "kills", 5),
      ctx.repo.matches.topStats(server.id, "combat", 5),
      ctx.repo.matches.topStats(server.id, "support", 5),
      ctx.repo.stats.leaderboard("playtime", 5, [server.id]),
      ctx.repo.stats.leaderboard("kills", 5, [server.id]),
      ctx.repo.matches.participantCounts(server.id),
    ]);
    const playersIn = new Map(counts.map((c) => [c.matchId, c.players]));
    const overrides = new Map(overrideRows.map((r) => [r.mapId, r]));
    const layers = new Map<string, { pretty: string; mode: string; attackers: string | null }>();
    const layerOf = (mapId: string | null, game: string) => {
      const id = mapId ?? "";
      let l = layers.get(id);
      if (!l) {
        const built = buildLayer(id, game, overrides) as { pretty_name?: string; game_mode?: string; attackers?: string | null } | null;
        l = { pretty: built?.pretty_name || id || "Unknown map", mode: built?.game_mode ?? "", attackers: built?.attackers ?? null };
        layers.set(id, l);
      }
      return l;
    };

    // The scan: newest rounds first, bounded. `truncated` rides the wire so the page can say
    // "of the last N rounds" instead of implying all-time when history outgrows the cap.
    const all: MatchRow[] = [];
    for (let off = 0; all.length < SERVER_STATS_SCAN; off += 1000) {
      const page = await ctx.repo.matches.list(server.id, Math.min(1000, SERVER_STATS_SCAN - all.length), off);
      all.push(...page);
      if (page.length < 1000) break;
    }
    const finished = all.filter((m) => m.endedAt);
    const minutesOf = (m: MatchRow) => Math.max(0, (Date.parse(m.endedAt!) - Date.parse(m.startedAt)) / 60000);

    const byMap = new Map<string, { id: string; name: string; mode: string; played: number; totalMin: number; alliesWins: number; axisWins: number }>();
    let alliesWins = 0, axisWins = 0, attackerGames = 0, attackerWins = 0;
    const quality = { contested: 0, decisive: 0, stomp: 0, crash: 0, other: 0, scored: 0 };
    for (const m of finished) {
      const layer = layerOf(m.map, m.game ?? server.game);
      const key = m.map ?? "";
      let row = byMap.get(key);
      if (!row) { row = { id: key, name: layer.pretty, mode: layer.mode, played: 0, totalMin: 0, alliesWins: 0, axisWins: 0 }; byMap.set(key, row); }
      row.played += 1;
      row.totalMin += minutesOf(m);
      if (m.winner === "allies") { row.alliesWins += 1; alliesWins += 1; }
      else if (m.winner === "axis") { row.axisWins += 1; axisWins += 1; }
      if (layer.attackers && m.winner) { attackerGames += 1; if (m.winner === layer.attackers) attackerWins += 1; }
      if (m.alliedScore !== null && m.axisScore !== null) {
        quality.scored += 1;
        if (m.alliedScore === 2 && m.axisScore === 2) quality.crash += 1;
        else {
          const gap = Math.abs(m.alliedScore - m.axisScore);
          if (gap <= 1) quality.contested += 1;
          else if (gap <= 3) quality.decisive += 1;
          else if (gap >= 5) quality.stomp += 1;
          else quality.other += 1;
        }
      }
    }
    const maps = [...byMap.values()]
      .sort((a, b) => b.played - a.played)
      .slice(0, 12)
      .map((r) => ({ id: r.id, name: r.name, mode: r.mode, played: r.played, avgMinutes: Math.round(r.totalMin / r.played), alliesWins: r.alliesWins, axisWins: r.axisWins }));

    // Matches per UTC day, the last 28 days, zero-filled — an empty day is a fact, not a gap.
    const dayKey = (iso: string) => iso.slice(0, 10);
    const perDay = new Map<string, number>();
    for (const m of all) perDay.set(dayKey(m.startedAt), (perDay.get(dayKey(m.startedAt)) ?? 0) + 1);
    const activity: { day: string; matches: number }[] = [];
    for (let i = 27; i >= 0; i--) {
      const d = dayKey(new Date(Date.now() - i * 86_400_000).toISOString());
      activity.push({ day: d, matches: perDay.get(d) ?? 0 });
    }

    const record = (rows: (MatchStatRecord | ClassKillRecord)[]) =>
      rows.map((r) => ({
        name: r.playerName ?? "[No Name]", side: r.side, value: r.value,
        map: layerOf(r.map, server.game).pretty, seq: r.matchSeq, at: r.startedAt,
        // Class records carry the weapon that carried them — "127, with the howitzer".
        ...("weapon" in r && r.weapon ? { weapon: r.weapon } : {}),
      }));

    /*
     * Weapon-class boards, from the worker's rollups: the best single round and the career
     * leader per class. Only classes with data draw a board, and "other" stays off — a record
     * for the bucket of unclassified weapons tells nobody anything. Ordered by the biggest
     * single-round count, which puts the classes people actually fight over on top.
     */
    const classIds = (await ctx.repo.matches.classesWithData(server.id)).filter((c) => c !== "other");
    const classLabels = new Map(weaponClassesOf(getGame(server.game)?.descriptor).map((c) => [c.id, c.label]));
    const classRecords = (await Promise.all(classIds.map(async (classId) => ({
      classId,
      label: classLabels.get(classId) ?? classId,
      best: record(await ctx.repo.matches.topClassKills(server.id, classId, 3)),
      career: (await ctx.repo.matches.classTotals(server.id, classId, 3)).map((t) => ({ name: t.name ?? "[No Name]", kills: t.kills })),
      // The victim side of the same rows — who has died to this class the most, career.
      deaths: (await ctx.repo.matches.classDeathTotals(server.id, classId, 3)).map((t) => ({ name: t.name ?? "[No Name]", deaths: t.deaths })),
    })))).sort((a, b) => (b.best[0]?.value ?? 0) - (a.best[0]?.value ?? 0));

    /*
     * Individual weapons — the number people actually argue about is "236 with the Gewehr", not
     * a class total. The boards are the server's most-used weapons; each carries its best single
     * round and its career leader.
     */
    const weapons = await ctx.repo.matches.weaponSummary(server.id, 12);
    const weaponRecords = await Promise.all(weapons.map(async (w) => ({
      weapon: w.weapon,
      classId: w.classId,
      label: classLabels.get(w.classId) ?? w.classId,
      totalKills: w.totalKills,
      best: record(await ctx.repo.matches.topWeaponKills(server.id, w.weapon, 1)),
      career: (await ctx.repo.matches.weaponTotals(server.id, w.weapon, 1)).map((t) => ({ name: t.name ?? "[No Name]", kills: t.kills })),
      deaths: (await ctx.repo.matches.weaponDeathTotals(server.id, w.weapon, 1)).map((t) => ({ name: t.name ?? "[No Name]", deaths: t.deaths })),
    })));

    /*
     * Seeding health, from participant counts — how many stat rows a round produced IS how many
     * people played it. A round is SEEDED at 60+, and a round under 40 is the grind that got it
     * there. All of it derives from finished rounds that actually have participant data: history
     * imported without scoreboards measures nothing, and the card hides rather than guesses.
     */
    const measured = finished.filter((m) => (playersIn.get(m.id) ?? 0) >= 2);
    let seeding: Record<string, unknown> | null = null;
    if (measured.length > 0) {
      const seeded = measured.filter((m) => playersIn.get(m.id)! >= 60);
      const hoursUtc = Array.from({ length: 24 }, () => 0);
      for (const m of seeded) hoursUtc[new Date(m.startedAt).getUTCHours()]! += 1;

      // Seeding heroes: who shows up for the low-pop grind, counted in rounds. Recent low-pop
      // rounds only (bounded), so one loyal year does not become an unbeatable wall.
      const lowPop = measured.filter((m) => playersIn.get(m.id)! < 40).slice(0, 300);
      const heroRounds = new Map<string, number>();
      if (lowPop.length > 0) {
        const rows = await ctx.repo.matches.participants(lowPop.map((m) => m.id));
        for (const r of rows) {
          const name = r.playerName ?? "[No Name]";
          heroRounds.set(name, (heroRounds.get(name) ?? 0) + 1);
        }
      }
      const heroes = [...heroRounds.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([name, rounds]) => ({ name, rounds }));

      // Server-killer maps: what loaded after a seeded round and emptied the server. The walk is
      // chronological (the scan arrives newest first), and only pairs where both rounds have
      // participant data count — a gap in the record is a gap, not a death.
      const chrono = [...measured].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const after = new Map<string, { name: string; after: number; drops: number }>();
      for (let i = 1; i < chrono.length; i++) {
        const prev = playersIn.get(chrono[i - 1]!.id)!;
        if (prev < 60) continue;
        const cur = chrono[i]!;
        const key = cur.map ?? "";
        let row = after.get(key);
        if (!row) { row = { name: layerOf(cur.map, cur.game ?? server.game).pretty, after: 0, drops: 0 }; after.set(key, row); }
        row.after += 1;
        if (playersIn.get(cur.id)! <= 30) row.drops += 1;
      }
      const killers = [...after.values()]
        .filter((k) => k.drops >= 2)
        .sort((a, b) => b.drops / b.after - a.drops / a.after || b.drops - a.drops)
        .slice(0, 4)
        .map((k) => ({ map: k.name, drops: k.drops, after: k.after }));

      seeding = {
        measuredRounds: measured.length,
        seededShare: Math.round((seeded.length / measured.length) * 100),
        avgPlayers: Math.round(measured.reduce((n, m) => n + playersIn.get(m.id)!, 0) / measured.length),
        hoursUtc,
        heroes,
        killers,
      };
    }

    const body = {
      stats: {
        scannedMatches: all.length,
        truncated: all.length >= SERVER_STATS_SCAN,
        overview: {
          matches: all.length,
          avgMinutes: finished.length ? Math.round(finished.reduce((n, m) => n + minutesOf(m), 0) / finished.length) : null,
          alliesWins, axisWins,
          attackersWinPct: attackerGames >= 5 ? Math.round((attackerWins / attackerGames) * 100) : null,
        },
        maps, quality, activity, seeding, classRecords, weaponRecords,
        records: { kills: record(recKills), combat: record(recCombat), support: record(recSupport) },
        regulars: {
          playtime: topPlaytime.map((e) => ({ name: e.name, hours: Math.round(e.playtime / 3600) })),
          kills: topKills.map((e) => ({ name: e.name, kills: e.kills })),
        },
      },
    };
    serverStatsCache.set(server.id, { at: Date.now(), body });
    sendJson(res, 200, body);
  }),

  /**
   * A player's public CAREER on one server — the page a scoreboard name links to.
   *
   * Addressed by PLATFORM id, and only on servers whose publicPlayerIds toggle is ON: the id is
   * the address, and a server that withholds ids has no public address for a person — the whole
   * route answers the uniform 404 there, not a "turn it on" hint. Two more privacy rules: a
   * player who never played THIS server is a 404 (this address must not become a probe of the
   * whole player directory), and the internal id never crosses — the platform id in the URL is
   * the only identifier echoed back.
   */
  route("GET", "/api/public/:slug/player/:platformId", async (req, res, ctx, params) => {
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    if (!limiter.allow("public_player", addr, 30)) {
      res.setHeader("retry-after", "60");
      return sendJson(res, 429, { error: "rate limited" });
    }
    const server = await ctx.repo.servers.findBySlug(params.slug ?? "").catch(() => null);
    if (!server || !server.streamerMode || !server.publicPlayerIds) return sendJson(res, 404, { error: "not found" });
    const player = await ctx.repo.players.findByPlatformId(params.platformId ?? "").catch(() => null);
    if (!player) return sendJson(res, 404, { error: "not found" });

    const [byServer, recent, overrideRows, weaponTotals, weaponDeaths] = await Promise.all([
      ctx.repo.stats.byServer(player.id),
      ctx.repo.matches.listForPlayer(player.id, 200),
      ctx.repo.mapNames.list(server.game).catch(() => []),
      ctx.repo.matches.playerWeaponTotals(server.id, player.id, 10),
      ctx.repo.matches.playerWeaponDeathTotals(server.id, player.id, 10),
    ]);
    const career = byServer.find((r) => r.serverId === server.id) ?? null;
    const rounds = recent.filter((r) => r.serverId === server.id).slice(0, 15);
    if (!career && rounds.length === 0) return sendJson(res, 404, { error: "not found" });

    const overrides = new Map(overrideRows.map((r) => [r.mapId, r]));
    const descriptor = getGame(server.game)?.descriptor;
    const prettyOf = (mapId: string | null) => {
      const built = buildLayer(mapId ?? "", server.game, overrides) as { pretty_name?: string } | null;
      return built?.pretty_name || mapId || "Unknown map";
    };
    // Career role time, named by the game. The "-1" key is the imported-playtime sentinel and
    // every negative key is bookkeeping, not a role someone played.
    const roles = Object.entries(career?.roleSeconds ?? {})
      .filter(([k, v]) => Number(k) >= 0 && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => ({ role: descriptor?.roles?.[Number(k)] ?? `Role ${k}`, seconds: v }));

    sendJson(res, 200, {
      player: { name: player.name, platform: player.platform, platformId: player.platformId },
      career: career ? {
        kills: career.kills, deaths: career.deaths, teamkills: career.teamkills,
        playtimeSec: career.playtimeSec, visits: career.visits,
        combat: career.combat, offense: career.offense, defense: career.defense, support: career.support,
        slSeconds: career.slSeconds, matchesPlayed: career.matchesPlayed, matchesWon: career.matchesWon,
        highestLevel: career.highestLevel,
      } : null,
      roles,
      weapons: weaponTotals,
      deathsTo: weaponDeaths,
      rounds: rounds.map((r) => ({
        seq: r.seq, map: prettyOf(r.map), startedAt: r.startedAt, endedAt: r.endedAt,
        side: r.side, kills: r.kills, deaths: r.deaths,
        won: r.winner && r.side ? r.winner === r.side : null,
      })),
    });
  }),
];

/** Server-stats scan bound and cache. The cap keeps a decade of history from becoming a per-visit
 *  table walk; the cache keeps a shared Discord link from re-running even the capped scan. */
const SERVER_STATS_SCAN = 5000;
const SERVER_STATS_TTL_MS = 5 * 60_000;
const serverStatsCache = new Map<string, { at: number; body: unknown }>();
