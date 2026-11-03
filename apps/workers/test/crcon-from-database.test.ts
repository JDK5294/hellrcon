/**
 * The CRCON-database exporter. What matters here is not that rows move, but that they come out in
 * the shape CRCON's own API would have produced — that is the contract the whole verified
 * transform downstream depends on. So the assertions are on real archive bytes: a real
 * ArchiveWriter, read back off disk and parsed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlClient } from "../src/crcon-import/from-database.ts";
// Runtime imports come from dist: ArchiveWriter uses a TS parameter property, which Node's
// strip-only mode cannot execute from source (same reason the pull test loads the runner there).
const { ArchiveWriter } = await import("../dist/crcon-import/archive.js");
const { exportServer, inventory, iso, logDataType, mapResult, roleSecondsFromUnits } =
  await import("../dist/crcon-import/from-database.js");

/** A CRCON database that answers by matching the query text — enough to drive the exporter
 *  end to end without a server. Keyset paging is honoured so the streaming path is real. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>): SqlClient {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const pick = (name: string) => tables[name] ?? [];
      if (/count\(\*\)::int AS n FROM (\w+)$/.test(sql)) {
        const t = sql.match(/FROM (\w+)$/)![1]!;
        if (!(t in tables)) throw new Error(`relation "${t}" does not exist`);
        return { rows: [{ n: pick(t).length }] as T[] };
      }
      if (sql.includes("FROM log_lines GROUP BY")) {
        const by = new Map<string, { key: string; n: number; lo: unknown; hi: unknown }>();
        for (const r of pick("log_lines")) {
          const key = String(r.server ?? "");
          const cur = by.get(key) ?? { key, n: 0, lo: r.event_time, hi: r.event_time };
          cur.n += 1;
          by.set(key, cur);
        }
        return { rows: [...by.values()] as T[] };
      }
      if (sql.includes("FROM map_history GROUP BY")) {
        const by = new Map<string, number>();
        for (const r of pick("map_history")) by.set(String(r.server_number), (by.get(String(r.server_number)) ?? 0) + 1);
        return { rows: [...by].map(([key, n]) => ({ key, n })) as T[] };
      }
      if (sql.includes("WHERE type = 'KILL' GROUP BY")) {
        const by = new Map<string, number>();
        for (const r of pick("log_lines")) if (r.type === "KILL") by.set(String(r.server ?? ""), (by.get(String(r.server ?? "")) ?? 0) + 1);
        return { rows: [...by].map(([key, n]) => ({ key, n })) as T[] };
      }
      if (sql.includes("sum(ps.kills)")) {
        const by = new Map<string, number>();
        for (const ps of pick("player_stats")) {
          const m = pick("map_history").find((r) => r.id === ps.map_id);
          if (!m) continue;
          const key = String(m.server_number);
          by.set(key, (by.get(key) ?? 0) + Number(ps.kills ?? 0));
        }
        return { rows: [...by].map(([key, n]) => ({ key, n })) as T[] };
      }
      if (sql.includes("FROM player_sessions GROUP BY")) {
        const by = new Map<string, number>();
        for (const r of pick("player_sessions")) by.set(String(r.server_number), (by.get(String(r.server_number)) ?? 0) + 1);
        return { rows: [...by].map(([key, n]) => ({ key, n })) as T[] };
      }
      // The streamed reads: [ ...filter, lastId, limit ]
      const lastId = Number(params[params.length - 2] ?? 0);
      const after = (rows: Record<string, unknown>[]) => rows.filter((r) => Number(r.id) > lastId).sort((a, b) => Number(a.id) - Number(b.id));
      if (sql.includes("FROM map_history m")) {
        const server = Number(params[0]);
        return {
          rows: after(pick("map_history").filter((r) => Number(r.server_number) === server)).map((m) => ({
            ...m,
            player_stats: pick("player_stats").filter((s) => s.map_id === m.id).map((s) => ({
              ...s, player_id: pick("steam_id_64").find((p) => p.id === s.playersteamid_id)?.steam_id_64, player: s.name,
            })),
          })) as T[],
        };
      }
      if (sql.includes("FROM map_history WHERE")) {
        const server = Number(params[0]);
        return { rows: after(pick("map_history").filter((r) => Number(r.server_number) === server)) as T[] };
      }
      if (sql.includes("FROM steam_id_64 p")) {
        const server = Number(params[0]);
        return {
          rows: after(pick("steam_id_64")).map((p) => ({
            id: p.id, player_id: p.steam_id_64, created: p.created,
            names: pick("player_names").filter((n) => n.playersteamid_id === p.id).map((n) => ({ name: n.name, created: n.created, last_seen: n.last_seen })),
            // The point of the whole exercise: sessions filtered to ONE server.
            sessions: pick("player_sessions").filter((s) => s.playersteamid_id === p.id && Number(s.server_number) === server)
              .map((s) => ({ start: s.start, end: s.end })),
            received_actions: [], comments: [], flags: [],
            vips: pick("player_vip").filter((v) => v.playersteamid_id === p.id && Number(v.server_number) === server)
              .map((v) => ({ server_number: v.server_number, expiration: v.expiration })),
            watchlist: pick("player_watchlist").find((w) => w.playersteamid_id === p.id) ?? null,
            steaminfo: null,
          })) as T[],
        };
      }
      if (sql.includes("FROM log_lines l")) {
        const server = String(params[0]);
        return {
          rows: after(pick("log_lines").filter((r) => String(r.server) === server)).map((l) => ({
            ...l,
            player1_id: pick("steam_id_64").find((p) => p.id === l.player1_steamid)?.steam_id_64 ?? null,
            player2_id: pick("steam_id_64").find((p) => p.id === l.player2_steamid)?.steam_id_64 ?? null,
          })) as T[],
        };
      }
      if (sql.includes("FROM message_template")) return { rows: pick("message_template") as T[] };
      return { rows: [] };
    },
  };
}

function readArchive(file: string): { dataType: string; entityKey: string; raw: Record<string, unknown> }[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("log types bucket into the right stage, with the ambiguous prefixes resolved", () => {
  // "TEAM KILL" must not fall into KILL, and the auto-TK lines must not fall into ADMIN.
  assert.equal(logDataType("TEAM KILL"), "log_teamkill");
  assert.equal(logDataType("KILL"), "log_kill");
  assert.equal(logDataType("TK AUTO KICKED"), "log_tkauto");
  assert.equal(logDataType("ADMIN KICKED"), "log_admin");
  assert.equal(logDataType("CHAT[Allies][Team]"), "log_chat");
  assert.equal(logDataType("CONNECTED"), "log_connect");
  assert.equal(logDataType("DISCONNECTED"), "log_disconnect");
  assert.equal(logDataType("MATCH START"), "log_match");
  assert.equal(logDataType("VOTE STARTED"), "log_vote");
  assert.equal(logDataType("CAMERA"), "log_camera");
  assert.equal(logDataType(""), null);
  assert.equal(logDataType(null), null);
});

test("the round result is translated to the spelling the transform reads", () => {
  // Stored {Axis, Allied}; served {axis, allied}. Passing the raw column through would null
  // every score in the import — silently.
  assert.deepEqual(mapResult({ Allied: 5, Axis: 2 }), { allied: 5, axis: 2 });
  assert.deepEqual(mapResult({ allied: 3, axis: 1 }), { allied: 3, axis: 1 });
  assert.equal(mapResult({ Axis: 2 }), null, "CRCON's own rule: no Allied key means no result");
  assert.equal(mapResult(null), null);
});

test("every timestamp spelling Postgres can print comes out a real UTC instant", () => {
  // Naive (timestamp ::text) — CRCON's convention: stamped UTC.
  assert.equal(iso("2021-03-01 00:10:00"), "2021-03-01T00:10:00.000Z");
  assert.equal(iso("2021-03-01 00:10:00.123"), "2021-03-01T00:10:00.123Z");
  // timestamptz ::text renders UTC as a bare "+00", which Date.parse refuses raw — an install
  // that used timestamptz must still export instants, not a file of nulls.
  assert.equal(iso("2021-03-01 00:10:00+00"), "2021-03-01T00:10:00.000Z");
  assert.equal(iso("2021-03-01 00:10:00.5+00"), "2021-03-01T00:10:00.500Z");
  assert.equal(iso("2021-06-01 12:00:00-05"), "2021-06-01T17:00:00.000Z");
  assert.equal(iso("2021-03-01 05:40:00+05:30"), "2021-03-01T00:10:00.000Z");
  assert.equal(iso(new Date("2021-03-01T00:10:00Z")), "2021-03-01T00:10:00.000Z");
  assert.equal(iso("not a time"), null);
  assert.equal(iso(null), null);
});

test("unit history collapses into seconds per role, closed by the round length", () => {
  // Joined as role 0, switched to role 3 sixty seconds in, round ran 100s from the first entry.
  const secs = roleSecondsFromUnits([{ ts: 1000, team: 1, squad: 0, role: 0 }, { ts: 1060, team: 1, squad: 0, role: 3 }], 100);
  assert.deepEqual(secs, { "0": 60, "3": 40 });
  assert.deepEqual(roleSecondsFromUnits([], 100), {});
  assert.deepEqual(roleSecondsFromUnits(null, 100), {});
});

test("inventory counts what is actually in the database and flags what would import wrong", async () => {
  const db = fakeDb({
    steam_id_64: [{ id: 1 }], log_lines: [{ id: 1, server: "1" }, { id: 2, server: "2" }, { id: 3, server: "1" }],
    map_history: [{ id: 1, server_number: 1 }], player_stats: [], player_sessions: [{ id: 1, server_number: 2 }],
    players_actions: [], player_comments: [], player_names: [], player_flags: [], player_watchlist: [],
    player_vip: [], blacklist: [], blacklist_record: [], message_template: [],
  });
  const inv = await inventory(db);
  assert.deepEqual(inv.servers.map((s) => [s.key, s.logLines, s.rounds, s.sessions]),
    [["1", 2, 1, 0], ["2", 1, 0, 1]], "both servers found, counted separately");
  assert.equal(inv.totals.log_lines, 3);
  assert.deepEqual(inv.warnings, []);

  // An install that wrote server NAMES into log_lines.server would export nothing at all —
  // that has to be visible up front, not discovered as an empty archive.
  const named = await inventory(fakeDb({ log_lines: [{ id: 1, server: "Lynx Division #1" }], map_history: [], player_sessions: [] }));
  assert.ok(named.warnings.some((w) => w.includes("non-numeric")), "non-numeric server values are flagged");
  assert.ok(named.warnings.some((w) => w.includes("missing")), "absent tables are reported, not fatal");
});

test("a pruned log is flagged before import: scoreboard kills far above log kills", async () => {
  // 900 kills attested by round scoreboards, 3 KILL lines left in the log — CRCON trimmed it.
  // Careers count kill events, so without this warning the low leaderboard gets blamed on the
  // import instead of on the source's missing lines.
  const inv = await inventory(fakeDb({
    log_lines: [1, 2, 3].map((id) => ({ id, server: "1", type: "KILL" })),
    map_history: [{ id: 10, server_number: 1 }],
    player_stats: [{ id: 1, map_id: 10, kills: 900 }],
    player_sessions: [],
  }));
  assert.ok(inv.warnings.some((w) => w.includes("pruned") && w.includes("900")), "the shortfall is named with its numbers");
});

test("export writes one server's history in the API's shape, and leaves the other server's out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crcon-db-"));
  const file = join(dir, "a.ndjson");
  try {
    const db = fakeDb({
      steam_id_64: [{ id: 1, steam_id_64: "76561198000000001", created: new Date("2021-01-01T00:00:00Z") }],
      player_names: [{ playersteamid_id: 1, name: "Alpha", created: new Date("2021-01-01T00:00:00Z"), last_seen: new Date("2021-06-01T00:00:00Z") }],
      // One session on each server. Only server 1's may be exported into server 1's archive —
      // this is the split CRCON's API cannot express.
      player_sessions: [
        { id: 1, playersteamid_id: 1, server_number: 1, start: new Date("2021-03-01T00:00:00Z"), end: new Date("2021-03-01T01:00:00Z") },
        { id: 2, playersteamid_id: 1, server_number: 2, start: new Date("2021-03-02T00:00:00Z"), end: new Date("2021-03-02T01:00:00Z") },
      ],
      player_vip: [{ playersteamid_id: 1, server_number: 1, expiration: new Date("2027-01-01T00:00:00Z") }],
      player_watchlist: [],
      map_history: [
        { id: 10, server_number: 1, map_name: "foy_warfare", start: new Date("2021-03-01T00:00:00Z"), end: new Date("2021-03-01T01:30:00Z"), result: { Allied: 4, Axis: 1 }, match_time: 5400, game_layout: null, cap_flips: [] },
        { id: 11, server_number: 2, map_name: "carentan_warfare", start: new Date("2021-03-02T00:00:00Z"), end: new Date("2021-03-02T01:00:00Z"), result: { Allied: 3, Axis: 2 }, match_time: 3600, game_layout: null, cap_flips: [] },
      ],
      player_stats: [{ id: 1, map_id: 10, playersteamid_id: 1, name: "Alpha", kills: 7, deaths: 3, teamkills: 0, combat: 250, offense: 100, defense: 60, support: 30, vehicle_kills: 0, vehicles_destroyed: 0, time_seconds: 540, level: 42, units: [{ ts: 0, team: 1, squad: 0, role: 3 }] }],
      log_lines: [
        { id: 100, server: "1", type: "KILL", event_time: new Date("2021-03-01T00:10:00Z"), player1_steamid: 1, player1_name: "Alpha", player2_steamid: 1, player2_name: "Alpha", weapon: "M1 GARAND", raw: "x", content: "y" },
        { id: 101, server: "2", type: "KILL", event_time: new Date("2021-03-02T00:10:00Z"), player1_steamid: 1, player1_name: "Alpha", player2_steamid: 1, player2_name: "Alpha", weapon: "M1 GARAND", raw: "x", content: "y" },
        { id: 102, server: "1", type: "TEAM KILL", event_time: new Date("2021-03-01T00:20:00Z"), player1_steamid: 1, player1_name: "Alpha", player2_steamid: 1, player2_name: "Alpha", weapon: "M1 GARAND", raw: "x", content: "y" },
      ],
      message_template: [{ content: "Welcome", category: "welcome" }],
    });

    const archive = new ArchiveWriter(file, true);
    const counts = await exportServer({ pool: db, serverNumber: 1, archive, batchSize: 500 });
    await archive.close();
    const rows = readArchive(file);
    const of = (dt: string) => rows.filter((r) => r.dataType === dt);

    // The archive is self-describing, so the transform's cross-server guard arms itself.
    assert.deepEqual(of("meta")[0]!.raw, { server_number: 1 });

    // Server 2 is absent everywhere — not filtered later, never written.
    assert.equal(of("map_history").length, 1);
    assert.equal(of("map_history")[0]!.raw.id, 10);
    assert.equal(of("log_kill").length, 1, "only server 1's kill");
    assert.equal(of("log_kill")[0]!.entityKey, "100", "keyed on log_lines.id — the same key an API pull produces");
    assert.equal(of("log_teamkill").length, 1);
    assert.equal(counts.log_kill, 1);

    // The score arrives in the served spelling, so the transform can actually read it.
    assert.deepEqual(of("map_history")[0]!.raw.result, { allied: 4, axis: 1 });

    // The scoreboard carries the per-round figures no log line holds.
    const sb = of("map_scoreboard")[0]!;
    assert.equal(sb.entityKey, "10");
    const line = (sb.raw.player_stats as Record<string, unknown>[])[0]!;
    assert.equal(line.player_id, "76561198000000001");
    assert.equal(line.kills, 7);
    assert.equal(line.time_seconds, 540);
    assert.ok(Array.isArray(line.units), "unit history rides along for the role split");

    // The player's profile carries ONLY this server's session — the whole reason for reading the
    // file instead of the API, whose serializer drops the session's server_number.
    const detail = of("player_detail")[0]!;
    const sessions = detail.raw.sessions as Record<string, unknown>[];
    assert.equal(sessions.length, 1, "server 2's session is not in server 1's archive");
    assert.equal(sessions[0]!.start, "2021-03-01T00:00:00.000Z", "dates normalized to ISO for the archive");
    assert.equal((detail.raw.names as Record<string, unknown>[])[0]!.name, "Alpha");

    // VIP for this server, in get_vip_ids' shape.
    assert.equal(of("vip")[0]!.raw.player_id, "76561198000000001");
    assert.equal(of("standard_message")[0]!.raw.kind, "welcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
