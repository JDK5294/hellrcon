/**
 * CRCON database → archive.
 *
 * The API pull (runner.ts) walks CRCON's HTTP endpoints. This reads CRCON's Postgres directly,
 * which is what you want when you hold the install's `db_data` volume: nothing is paginated,
 * rate-limited, or filtered by an endpoint's defaults, and — the reason this exists — every row
 * carries the server column that CRCON's own serializers drop on the way out.
 *
 * THE CONTRACT: emit exactly what CRCON's `to_dict()` would have emitted. The archive format and
 * the whole downstream transform stay untouched, so everything already verified about the import
 * (idempotence, the overlap cutoff, the cross-server guard, integrity/reset) applies unchanged.
 * Where their DB shape and their API shape differ, THEIR API SHAPE WINS. The sharp one:
 * `map_history.result` is stored `{Axis, Allied}` but served `{axis, allied}` — pass the raw
 * column through and every imported score is silently null.
 *
 * Dedupe with an existing API-sourced import is automatic, not hoped for: log rows key on
 * `log_lines.id`, the same integer the API returns, so the transform derives the same
 * `crcon:<id>` and a row already imported is skipped rather than doubled.
 */
import type { ArchiveWriter } from "./archive.js";

/**
 * The only thing this module needs from a database driver. Declared structurally rather than
 * imported from `pg` so the exporter carries no driver dependency and can be exercised in full
 * against a fake — the row mapping is where the risk lives, and it deserves tests that run
 * without standing up a CRCON.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** What CRCON's log `type` values map onto in our archive (the API pull's stage names). */
const LOG_TYPE_TO_DATATYPE: [RegExp, string][] = [
  [/^TEAM KILL/i, "log_teamkill"],
  [/^KILL/i, "log_kill"],
  [/^MATCH/i, "log_match"],
  [/^CONNECTED/i, "log_connect"],
  [/^DISCONNECTED/i, "log_disconnect"],
  [/^TEAMSWITCH/i, "log_teamswitch"],
  [/^CHAT/i, "log_chat"],
  [/^CAMERA/i, "log_camera"],
  [/^VOTE/i, "log_vote"],
  [/^MESSAGE/i, "log_message"],
  [/^(TK AUTO|TK )/i, "log_tkauto"],
  [/^ADMIN/i, "log_admin"],
];

/** Bucket a CRCON log row's `type` into the archive dataType the transform expects.
 *  Order matters: "TEAM KILL" must be tested before "KILL", and the auto-TK lines before ADMIN. */
export function logDataType(type: unknown): string | null {
  const t = typeof type === "string" ? type.trim() : "";
  if (!t) return null;
  for (const [re, dt] of LOG_TYPE_TO_DATATYPE) if (re.test(t)) return dt;
  return null;
}

/**
 * ISO-8601 or null — with CRCON's timezone convention enforced.
 *
 * CRCON stores NAIVE timestamps and its own serializers stamp them UTC. The pg driver, however,
 * parses a naive `timestamp` column in the HOST's local zone — on any non-UTC machine that
 * shifts every instant by the UTC offset, silently. Consistently-shifted data still reconciles
 * clean, and a shifted `ts` even defeats the events dedupe against an earlier correctly-stamped
 * import (the conflict target includes ts), so this class of error DOUBLES data instead of
 * converging. Two defenses, so no pool configuration can reintroduce it:
 *   - every timestamp column in this module's SQL is cast ::text, so the driver never parses it;
 *   - a zone-less string here is treated as UTC (the same rule the transform's crconTime applies).
 * The Date branch stays for non-Postgres callers (tests hand real Dates, which are unambiguous).
 */
export function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v) {
    // Postgres renders a timestamptz's UTC zone as a bare "+00", which Date.parse refuses —
    // widen it to "+00:00" so an install that DID use timestamptz still exports real instants
    // instead of a file of nulls.
    const raw = v.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
    const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(raw);
    const t = Date.parse(hasZone ? raw : `${raw}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

/** CRCON stores a round's score as {Axis, Allied}; its API serves {axis, allied}. The transform
 *  reads the served spelling, so translate — and keep their "no Allied key means no result" rule,
 *  which is how an abandoned round stays scoreless instead of reading 0-0. */
export function mapResult(raw: unknown): { allied: number; axis: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const allied = r.Allied ?? r.allied;
  const axis = r.Axis ?? r.axis;
  if (allied === null || allied === undefined) return null;
  return { allied: Number(allied) || 0, axis: Number(axis) || 0 };
}

// The units → role-seconds collapse lives in @app/shared (the transform needs it too);
// re-exported here so the exporter's callers and tests keep one import site.
export { roleSecondsFromUnits } from "@app/shared";

/** One server's presence in the CRCON database, as counted rather than assumed. */
export interface ServerInventory {
  key: string;
  logLines: number;
  rounds: number;
  sessions: number;
  firstLog: string | null;
  lastLog: string | null;
  /** KILL lines in the log vs kills summed from the round scoreboards. On an untrimmed log the
   *  two are close; scoreboard kills far above log kills means CRCON pruned old log lines, and
   *  career kill counts (which derive from log events) will sit below the per-round record. */
  logKills: number;
  scoreboardKills: number;
}

export interface DatabaseInventory {
  servers: ServerInventory[];
  totals: Record<string, number>;
  /** Anything that would make an import lossy or wrong — surfaced before a single row is written. */
  warnings: string[];
}

/**
 * Read-only profile of a CRCON database: which servers are in it, how much each holds, and what
 * spans they cover. Run this BEFORE importing — it is the evidence that the archive about to be
 * built matches the install it came from, and it settles empirically what `log_lines.server`
 * actually holds (the number as a string on every CRCON we have seen, but an install old enough
 * to have written names there would silently import nothing, and that must be visible).
 */
export async function inventory(pool: SqlClient): Promise<DatabaseInventory> {
  const warnings: string[] = [];
  const totals: Record<string, number> = {};
  for (const t of ["steam_id_64", "log_lines", "map_history", "player_stats", "player_sessions",
                   "players_actions", "player_comments", "player_names", "player_flags",
                   "player_watchlist", "player_vip", "blacklist", "blacklist_record", "message_template"]) {
    try {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      totals[t] = rows[0]?.n ?? 0;
    } catch {
      totals[t] = -1; // table absent on this CRCON version — recorded, not fatal
      warnings.push(`table ${t} is missing from this database (older or newer CRCON schema)`);
    }
  }

  const logs = await pool.query<{ key: string; n: number; lo: Date | null; hi: Date | null }>(
    "SELECT coalesce(server, '') AS key, count(*)::int AS n, min(event_time)::text AS lo, max(event_time)::text AS hi FROM log_lines GROUP BY 1 ORDER BY 2 DESC",
  );
  const rounds = await pool.query<{ key: string; n: number }>(
    "SELECT server_number::text AS key, count(*)::int AS n FROM map_history GROUP BY 1",
  );
  const sess = await pool.query<{ key: string; n: number }>(
    "SELECT server_number::text AS key, count(*)::int AS n FROM player_sessions GROUP BY 1",
  );
  const logKills = await pool.query<{ key: string; n: number }>(
    "SELECT coalesce(server, '') AS key, count(*)::int AS n FROM log_lines WHERE type = 'KILL' GROUP BY 1",
  ).catch(() => ({ rows: [] as { key: string; n: number }[] }));
  const sbKills = await pool.query<{ key: string; n: number }>(
    `SELECT m.server_number::text AS key, coalesce(sum(ps.kills), 0)::int AS n
       FROM player_stats ps JOIN map_history m ON m.id = ps.map_id GROUP BY 1`,
  ).catch(() => ({ rows: [] as { key: string; n: number }[] }));

  const keys = new Set<string>([...logs.rows, ...rounds.rows, ...sess.rows].map((r) => r.key));
  const servers: ServerInventory[] = [...keys].sort().map((key) => {
    const l = logs.rows.find((r) => r.key === key);
    return {
      key,
      logLines: l?.n ?? 0,
      rounds: rounds.rows.find((r) => r.key === key)?.n ?? 0,
      sessions: sess.rows.find((r) => r.key === key)?.n ?? 0,
      firstLog: iso(l?.lo ?? null),
      lastLog: iso(l?.hi ?? null),
      logKills: logKills.rows.find((r) => r.key === key)?.n ?? 0,
      scoreboardKills: sbKills.rows.find((r) => r.key === key)?.n ?? 0,
    };
  });

  // The pruned-log tell: careers count kill EVENTS, so a log CRCON trimmed leaves career kills
  // below what the round scoreboards attest. Not an import fault — but it must be known BEFORE
  // the import, not discovered as "the leaderboard looks low" after it.
  for (const s of servers) {
    if (s.scoreboardKills > 0 && s.scoreboardKills > s.logKills * 1.05 + 50) {
      warnings.push(
        `server ${s.key || "(none)"}: round scoreboards attest ${s.scoreboardKills.toLocaleString()} kills but the log holds only ` +
        `${s.logKills.toLocaleString()} KILL lines — CRCON pruned old logs, so career kill counts will sit below the per-round record`,
      );
    }
  }

  // The filter this whole import rests on is a string match against log_lines.server. If those
  // values are not the server numbers the rounds/sessions use, an export would come out empty —
  // say so here rather than after a silent no-op run.
  const numericKeys = servers.filter((s) => s.logLines > 0 && /^\d+$/.test(s.key));
  if (servers.some((s) => s.logLines > 0) && numericKeys.length === 0) {
    warnings.push("log_lines.server holds non-numeric values (server names?) — map them to server numbers before exporting");
  }
  const blank = servers.find((s) => s.key === "" && s.logLines > 0);
  if (blank) warnings.push(`${blank.logLines} log lines carry no server value and belong to no server's archive`);
  return { servers, totals, warnings };
}

export interface ExportProgress { dataType: string; written: number }

interface ExportOptions {
  pool: SqlClient;
  /** The CRCON server number to export — matched against log_lines.server (as text),
   *  map_history.server_number, player_sessions.server_number and player_vip.server_number. */
  serverNumber: number;
  archive: ArchiveWriter;
  onProgress?: (p: ExportProgress) => void;
  /** Rows per fetch on the FLAT reads (log lines, rounds). Log lines run to the millions on a
   *  mature install. The aggregate-carrying stages page far smaller — see WIDE_BATCH. */
  batchSize?: number;
}

/**
 * Rows per fetch for the stages whose every row carries whole histories inside it.
 *
 * `pg` materialises a query's entire result before handing it back, so a batch is a memory
 * commitment, and "rows" is a terrible unit for one: a log line is a dozen scalars, while a player
 * row carries that player's every name, session, action, comment and flag as aggregated JSON, and a
 * scoreboard row carries every player line of a whole round. Paging all of them 5,000 at a time
 * meant the player stage allocating gigabytes inside a single query — before a single record was
 * written, which is why it died silently with an empty archive and no progress ever printed. These
 * stages are counted in the hundreds of rows, and are no slower for it: the cost is dominated by
 * the aggregates, not by the number of round trips.
 */
const WIDE_BATCH = 200;

/** Stream a query in keyset-paged batches, so a table with millions of rows never lands in memory
 *  at once. Keyset (id > last) rather than OFFSET: constant cost per batch instead of quadratic. */
async function* streamById<T extends { id: number }>(
  pool: SqlClient, sql: string, params: unknown[], batchSize: number,
): AsyncGenerator<T[]> {
  let lastId = 0;
  for (;;) {
    const { rows } = await pool.query<T>(sql, [...params, lastId, batchSize]);
    if (rows.length === 0) return;
    yield rows;
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) return;
  }
}

/**
 * Export one server's history out of a CRCON database and into an archive file.
 *
 * Every row lands in the same shape CRCON's API would have produced, so the archive is
 * indistinguishable from a pulled one except for being complete and correctly attributed.
 */
export async function exportServer(opts: ExportOptions): Promise<Record<string, number>> {
  const { pool, serverNumber, archive, onProgress } = opts;
  const batch = opts.batchSize ?? 5_000;
  const counts: Record<string, number> = {};
  const bump = (dataType: string, n = 1) => {
    if (n <= 0) return;
    counts[dataType] = (counts[dataType] ?? 0) + n;
    onProgress?.({ dataType, written: counts[dataType]! });
  };
  const put = (dataType: string, entityKey: string, raw: Record<string, unknown>) => {
    if (archive.append({ dataType, entityKey, raw })) bump(dataType);
  };

  // The stamp that makes this archive self-describing — the transform's pre-scan reads it and
  // drops anything naming another server, exactly as it does for a filtered API pull.
  put("meta", "server_number", { server_number: serverNumber });

  // ── Rounds ────────────────────────────────────────────────────────────────────────────────
  for await (const rows of streamById<Record<string, unknown> & { id: number }>(
    pool,
    `SELECT id, start::text AS start, "end"::text AS end, server_number, map_name, result, game_layout, cap_flips, match_time
       FROM map_history WHERE server_number = $1 AND "end" IS NOT NULL AND id > $2 ORDER BY id LIMIT $3`,
    [serverNumber], batch,
  )) {
    for (const r of rows) {
      put("map_history", String(r.id), {
        id: r.id,
        map_name: r.map_name,
        start: iso(r.start),
        end: iso(r.end),
        server_number: r.server_number,
        result: mapResult(r.result),
        game_layout: r.game_layout ?? null,
        cap_flips: r.cap_flips ?? [],
        match_time: r.match_time ?? 0,
      });
    }
    await archive.drain();
  }

  // ── Per-round scoreboards ─────────────────────────────────────────────────────────────────
  // One row per round carrying every player's line, which is the shape get_scoreboard_maps
  // returns and the shape the transform's second pass reads.
  for await (const rows of streamById<Record<string, unknown> & { id: number }>(
    pool,
    // The per-player line is the WHOLE player_stats row (to_jsonb), not a hand-picked column list.
    // A picked list silently drops whatever it doesn't name — and did: kills_by_type, the streak
    // counters, lifespan seconds and the per-round vote tallies never reached the archive, so
    // "in the archive if ever wanted" (the coverage doc's promise) was only true for the API pull.
    // Serializing the row makes the archive a full-fidelity stand-in for the backup folder — the
    // fields the transform reads keep their column names, unknown ones ride along for whatever
    // future backfill wants them, and a CRCON version with more or fewer columns exports cleanly
    // either way. Internal FK ids are stripped; the join supplies the real game id as player_id.
    `SELECT m.id, m.map_name, m.start::text AS start, m."end"::text AS end, m.server_number, m.result, m.match_time,
            (SELECT jsonb_agg((to_jsonb(ps) - 'playersteamid_id' - 'map_id' - 'id')
                              || jsonb_build_object('player_id', pid.steam_id_64, 'player', ps.name))
             FROM player_stats ps JOIN steam_id_64 pid ON pid.id = ps.playersteamid_id
             WHERE ps.map_id = m.id) AS player_stats
       FROM map_history m WHERE m.server_number = $1 AND m."end" IS NOT NULL AND m.id > $2 ORDER BY m.id LIMIT $3`,
    [serverNumber], WIDE_BATCH,
  )) {
    for (const r of rows) {
      const lines = Array.isArray(r.player_stats) ? r.player_stats : [];
      if (lines.length === 0) continue; // a round nobody scored in adds nothing the map_history row lacks
      put("map_scoreboard", String(r.id), {
        id: r.id,
        map_name: r.map_name,
        start: iso(r.start),
        end: iso(r.end),
        server_number: r.server_number,
        result: mapResult(r.result),
        match_time: r.match_time ?? 0,
        player_stats: lines,
      });
    }
    await archive.drain();
  }

  // ── Players and their profiles ────────────────────────────────────────────────────────────
  // Identities are install-wide (a player is the same person on both servers), so every player is
  // exported; what IS server-scoped — sessions, VIP — is filtered to this server. That split is
  // the whole reason the file beats the API: their serializer drops the session's server_number,
  // so an API-sourced import can only ever credit one install-wide pile of playtime.
  for await (const rows of streamById<Record<string, unknown> & { id: number }>(
    pool,
    `SELECT p.id, p.steam_id_64 AS player_id, p.created::text AS created,
            (SELECT json_agg(json_build_object('name', n.name, 'created', n.created, 'last_seen', n.last_seen)
                             ORDER BY n.last_seen DESC NULLS LAST)
               FROM player_names n WHERE n.playersteamid_id = p.id) AS names,
            (SELECT json_agg(json_build_object('start', s.start, 'end', s."end") ORDER BY s.start)
               FROM player_sessions s WHERE s.playersteamid_id = p.id AND s.server_number = $1) AS sessions,
            (SELECT json_agg(json_build_object('action_type', a.action_type, 'reason', a.reason,
                                               'by', a.by, 'time', a.time) ORDER BY a.time)
               FROM players_actions a WHERE a.playersteamid_id = p.id) AS received_actions,
            (SELECT json_agg(json_build_object('content', c.content, 'by', c.by,
                                               'creation_time', c.creation_time) ORDER BY c.creation_time)
               FROM player_comments c WHERE c.playersteamid_id = p.id) AS comments,
            (SELECT json_agg(json_build_object('flag', f.flag, 'comment', f.comment, 'modified', f.modified))
               FROM player_flags f WHERE f.playersteamid_id = p.id) AS flags,
            (SELECT row_to_json(w) FROM (SELECT is_watched, reason, by, count, modified
               FROM player_watchlist WHERE playersteamid_id = p.id) w) AS watchlist,
            (SELECT json_agg(json_build_object('server_number', v.server_number, 'expiration', v.expiration))
               FROM player_vip v WHERE v.playersteamid_id = p.id AND v.server_number = $1) AS vips,
            (SELECT row_to_json(si) FROM (SELECT country, profile
               FROM steam_info WHERE playersteamid_id = p.id) si) AS steaminfo
       FROM steam_id_64 p WHERE p.id > $2 ORDER BY p.id LIMIT $3`,
    [serverNumber], WIDE_BATCH,
  )) {
    for (const r of rows) {
      const pid = String(r.player_id ?? "");
      if (!pid) continue;
      const names = Array.isArray(r.names) ? r.names : [];
      const sessions = Array.isArray(r.sessions) ? r.sessions : [];
      const profile: Record<string, unknown> = {
        player_id: pid,
        created: iso(r.created),
        names,
        sessions,
        received_actions: Array.isArray(r.received_actions) ? r.received_actions : [],
        comments: Array.isArray(r.comments) ? r.comments : [],
        flags: Array.isArray(r.flags) ? r.flags : [],
        vips: Array.isArray(r.vips) ? r.vips : [],
        ...(r.watchlist ? { watchlist: r.watchlist } : {}),
        ...(r.steaminfo ? { steaminfo: r.steaminfo } : {}),
      };
      // Both rows the API pull produces, so the transform's cheap `player` pass and its rich
      // `player_detail` pass each get what they expect.
      put("player", pid, { player_id: pid, names, created: iso(r.created) });
      put("player_detail", pid, profile);
      // A live VIP for THIS server, in the shape get_vip_ids returns.
      const vip = (Array.isArray(r.vips) ? r.vips : [])[0] as Record<string, unknown> | undefined;
      if (vip) {
        put("vip", pid, {
          player_id: pid,
          name: (names[0] as Record<string, unknown> | undefined)?.name ?? "",
          expiration: iso(vip.expiration),
        });
      }
      if ((r.watchlist as Record<string, unknown> | null)?.is_watched) {
        put("watchlist", pid, { player_id: pid, names, ...(r.watchlist as Record<string, unknown>) });
      }
    }
    await archive.drain();
  }

  // ── The game log ──────────────────────────────────────────────────────────────────────────
  // The deep history, and by far the biggest table. `server` is matched as text because that is
  // how CRCON stores and filters it (get_historical_logs compares the column to a string).
  for await (const rows of streamById<Record<string, unknown> & { id: number }>(
    pool,
    `SELECT l.id, l.event_time::text AS event_time, l.type, l.player1_name, l.player2_name, l.weapon, l.raw, l.content, l.server,
            p1.steam_id_64 AS player1_id, p2.steam_id_64 AS player2_id
       FROM log_lines l
       LEFT JOIN steam_id_64 p1 ON p1.id = l.player1_steamid
       LEFT JOIN steam_id_64 p2 ON p2.id = l.player2_steamid
      WHERE l.server = $1::text AND l.id > $2 ORDER BY l.id LIMIT $3`,
    [String(serverNumber)], batch,
  )) {
    for (const r of rows) {
      const dt = logDataType(r.type);
      if (!dt) continue; // an action family we have no stage for — see docs/crcon-import-coverage.md
      put(dt, String(r.id), {
        id: r.id,
        action: r.type,
        event_time: iso(r.event_time),
        player1_id: r.player1_id ?? null,
        player1_name: r.player1_name ?? null,
        player2_id: r.player2_id ?? null,
        player2_name: r.player2_name ?? null,
        weapon: r.weapon ?? null,
        raw: r.raw ?? null,
        content: r.content ?? null,
        server: r.server ?? null,
      });
    }
    await archive.drain();
  }

  // ── Standard messages ─────────────────────────────────────────────────────────────────────
  try {
    const { rows } = await pool.query<Record<string, unknown>>("SELECT * FROM message_template");
    for (const r of rows) {
      const message = String(r.content ?? r.message ?? "").trim();
      if (!message) continue;
      const kind = String(r.category ?? r.type ?? "broadcast").toLowerCase();
      put("standard_message", `${kind}:${message}`, { kind, message });
    }
  } catch { /* older CRCON without the table — the inventory already reported it */ }

  return counts;
}
