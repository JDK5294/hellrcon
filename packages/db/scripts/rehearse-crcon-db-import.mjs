// FULL-CHAIN REHEARSAL — the two halves meet in one process, exactly as they will on the day:
//
//   CRCON-shaped Postgres (two servers' data, their real column shapes: {Axis,Allied} results,
//   Date columns, units JSON, shared log store)
//     → exportServer            (workers dist — the real exporter, real ArchiveWriter, real file)
//     → transformCrconArchive   (api dist — the REAL production Apply, into a real-Postgres repo)
//     → reconcile               (workers dist — must report COMPLETE against the CRCON database)
//     → re-Apply                (must change nothing: the one-and-done property)
//     → server 2 must be untouched by server 1's import.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createRepository } from "../dist/index.js";

process.env.CRCON_BACKUP_DIR = mkdtempSync(join(tmpdir(), "rehearse-330-"));
const { exportServer, inventory } = await import("../../../apps/workers/dist/crcon-import/from-database.js");
const { ArchiveWriter } = await import("../../../apps/workers/dist/crcon-import/archive.js");
const { reconcile, formatReport } = await import("../../../apps/workers/dist/crcon-import/reconcile.js");
const { transformCrconArchive } = await import("../../../apps/api/dist/crcon-transform.js");
const { crconBackupFile } = await import("../../shared/dist/index.js");

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// ── The CRCON side: their schema (the columns our SQL touches), their shapes ────────────────
const crcon = new pg.Pool({ connectionString: "postgres://postgres@127.0.0.1:5463/crcon", max: 2 });
await crcon.query(`
  CREATE TABLE steam_id_64 (id serial PRIMARY KEY, steam_id_64 text NOT NULL UNIQUE, created timestamp);
  CREATE TABLE player_names (id serial PRIMARY KEY, playersteamid_id int NOT NULL, name text, created timestamp, last_seen timestamp);
  CREATE TABLE player_sessions (id serial PRIMARY KEY, playersteamid_id int NOT NULL, start timestamp, "end" timestamp, created timestamp, server_number int, server_name text);
  CREATE TABLE players_actions (id serial PRIMARY KEY, playersteamid_id int NOT NULL, action_type text, reason text, by text, time timestamp);
  CREATE TABLE player_comments (id serial PRIMARY KEY, playersteamid_id int NOT NULL, content text, by text, creation_time timestamp);
  CREATE TABLE player_flags (id serial PRIMARY KEY, playersteamid_id int NOT NULL, flag text, comment text, modified timestamp);
  CREATE TABLE player_watchlist (id serial PRIMARY KEY, playersteamid_id int NOT NULL, is_watched boolean, reason text, by text, count int, modified timestamp);
  CREATE TABLE player_vip (id serial PRIMARY KEY, playersteamid_id int NOT NULL, server_number int, expiration timestamptz);
  CREATE TABLE map_history (id serial PRIMARY KEY, creation_time timestamp, start timestamp, "end" timestamp, server_number int, map_name text, result jsonb, game_layout jsonb, cap_flips jsonb, match_time int);
  CREATE TABLE player_stats (id serial PRIMARY KEY, playersteamid_id int NOT NULL, map_id int NOT NULL, name text,
    kills int, deaths int, teamkills int, combat int, offense int, defense int, support int,
    vehicle_kills int, vehicles_destroyed int, time_seconds int, level int, kills_and_assists int, deaths_and_redeploys int,
    weapons jsonb, death_by_weapons jsonb, most_killed jsonb, death_by jsonb, units jsonb);
  CREATE TABLE log_lines (id serial PRIMARY KEY, version int, creation_time timestamp, event_time timestamp, type text,
    player1_name text, player1_steamid int, player2_name text, player2_steamid int, weapon text, raw text, content text, server text);
  CREATE TABLE message_template (id serial PRIMARY KEY, content text, category text);
  CREATE TABLE blacklist (id serial PRIMARY KEY, name text);
  CREATE TABLE blacklist_record (id serial PRIMARY KEY, playersteamid_id int, blacklist_id int, reason text);
  CREATE TABLE steam_info (id serial PRIMARY KEY, playersteamid_id int, created timestamp, updated timestamp, profile jsonb, country text, bans jsonb);
`);

// Two players, two servers, one install. Alpha plays both servers; Bravo only server 2.
const T = (d, h) => `2021-03-0${d}T0${h}:00:00Z`;
await crcon.query(`INSERT INTO steam_id_64 (steam_id_64, created) VALUES ('76561198000000001', $1), ('76561198000000002', $1)`, [T(1, 0)]);
await crcon.query(`INSERT INTO player_names (playersteamid_id, name, created, last_seen) VALUES (1, 'Alpha', $1, $2), (2, 'Bravo', $1, $2)`, [T(1, 0), T(2, 5)]);
await crcon.query(`INSERT INTO player_sessions (playersteamid_id, start, "end", created, server_number, server_name)
  VALUES (1, $1, $2, $1, 1, 'one'), (1, $3, $4, $3, 2, 'two'), (2, $3, $4, $3, 2, 'two')`, [T(1, 1), T(1, 3), T(2, 1), T(2, 3)]);
await crcon.query(`INSERT INTO players_actions (playersteamid_id, action_type, reason, by, time) VALUES (1, 'PUNISH', 'afk', 'admin', $1)`, [T(1, 2)]);
await crcon.query(`INSERT INTO player_comments (playersteamid_id, content, by, creation_time) VALUES (1, 'good sport', 'admin', $1)`, [T(1, 2)]);
await crcon.query(`INSERT INTO player_vip (playersteamid_id, server_number, expiration) VALUES (1, 1, '2027-01-01T00:00:00Z'), (1, 2, '2027-01-01T00:00:00Z')`);
// Rounds: 2 finished on server 1, 1 finished + 1 OPEN on server 2 (the open one must not export as importable).
await crcon.query(`INSERT INTO map_history (start, "end", server_number, map_name, result, match_time) VALUES
  ($1, $2, 1, 'foy_warfare', '{"Allied": 4, "Axis": 1}', 5400),
  ($3, $4, 1, 'carentan_warfare', '{"Allied": 2, "Axis": 3}', 5400),
  ($1, $2, 2, 'utahbeach_warfare', '{"Allied": 5, "Axis": 0}', 5400),
  ($5, NULL, 2, 'kursk_warfare', NULL, 0)`, [T(1, 1), T(1, 2), T(1, 3), T(1, 4), T(2, 1)]);
await crcon.query(`INSERT INTO player_stats (playersteamid_id, map_id, name, kills, deaths, teamkills, combat, offense, defense, support,
    vehicle_kills, vehicles_destroyed, time_seconds, level, weapons, death_by_weapons, most_killed, death_by, units) VALUES
  (1, 1, 'Alpha', 7, 3, 0, 250, 100, 60, 30, 0, 0, 3500, 42, '{"M1 GARAND": 7}', '{}', '{}', '{}', '[{"ts": 0, "team": 1, "squad": 0, "role": 3}]'),
  (1, 3, 'Alpha', 5, 5, 1, 180, 80, 40, 20, 0, 0, 3400, 42, '{}', '{}', '{}', '{}', '[]'),
  (2, 3, 'Bravo', 2, 8, 0, 90, 30, 20, 10, 0, 0, 3300, 17, '{}', '{}', '{}', '{}', '[]')`);
// The shared log store: both servers' lines in ONE table, exactly the trap the whole arc fixes.
const L = async (server, type, time, p1, p2, weapon) =>
  crcon.query(`INSERT INTO log_lines (event_time, type, player1_name, player1_steamid, player2_name, player2_steamid, weapon, raw, content, server, version, creation_time)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'raw', '', $8, 1, $1)`, [time, type, p1 ? "Alpha" : null, p1, p2 ? "Alpha" : null, p2, weapon ?? null, server]);
await L("1", "KILL", T(1, 1) /* in round 1 */, 1, 2, "M1 GARAND");
await L("1", "KILL", T(1, 3), 1, 2, "M1 GARAND");
await L("1", "TEAM KILL", T(1, 3), 1, 1, "M1 GARAND");
await L("1", "CONNECTED", T(1, 1), 1, null, null);
await L("1", "DISCONNECTED", T(1, 2), 1, null, null);
await L("1", "MATCH START", T(1, 1), null, null, null);
await L("1", "MATCH ENDED", T(1, 2), null, null, null);
await L("1", "CHAT[Allies][Team]", T(1, 1), 1, null, null);
await L("2", "KILL", T(2, 1), 2, 1, "MP40");        // server 2's line — must NOT land in server 1
await L("2", "CONNECTED", T(2, 1), 2, null, null);
await crcon.query(`INSERT INTO message_template (content, category) VALUES ('Welcome to the server', 'welcome')`);

// ── Inventory first, like the runbook says ─────────────────────────────────────────────────
const inv = await inventory(crcon);
eq(inv.servers.length, 2, "both servers present");
eq(inv.warnings.length, 0, "clean inventory");

// ── Our side: a REAL Postgres repo, and our two server rows ─────────────────────────────────
const repo = await createRepository({ DATABASE_URL: "postgres://postgres@127.0.0.1:5463/ours" });
if (repo.constructor.name === "InMemoryRepository") throw new Error("fell back to memory store");
const s1 = await repo.servers.create({ name: "one", host: "127.0.0.1", port: 1, password: "x" });
const s2 = await repo.servers.create({ name: "two", host: "127.0.0.1", port: 2, password: "x" });

// ── The user's real starting point: part of this history was ALREADY imported via the API ──
// The old network pull wrote kill log-id 1 as crcon:1 with the correct UTC instant, and bumped
// the career. The database import must CONVERGE with that — same key, same instant — not stack
// a second copy (the events conflict target includes ts, so a shifted instant would double).
{
  const pre = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Alpha" });
  const preVictim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000002", name: "Bravo" });
  const inserted = await repo.events.insert([{
    serverId: s1.id, ts: "2021-03-01T01:00:00.000Z", kind: "evt.kill",
    actorPlayerId: pre.id, actorName: "Alpha", victimPlayerId: preVictim.id, victimName: "Alpha",
    weapon: "M1 GARAND", data: null, dedupeKey: "crcon:1",
  }]);
  eq(inserted.length, 1, "the API-era event pre-seeds");
  await repo.stats.bump(pre.id, s1.id, { kills: 1 });
}

// ── Export server 1 → the real archive file → the REAL production Apply ────────────────────
const a1 = new ArchiveWriter(crconBackupFile(s1.id), true);
const counts1 = await exportServer({ pool: crcon, serverNumber: 1, archive: a1 });
await a1.close();
eq(counts1.log_kill, 2, "exporter counted server 1's kills only");
const by = { userId: null, name: "rehearsal" };
const sum1 = await transformCrconArchive(repo, s1, by);
if (sum1.errors.length) throw new Error(`transform errors: ${sum1.errors.join(" | ")}`);
eq(sum1.kills, 1, "only the kill the API import had NOT already landed applies — crcon:1 converges");
eq(sum1.teamkills, 1, "the team kill applied");
eq(sum1.matches, 2, "both finished server-1 rounds applied");
eq(sum1.skipped.otherServer, 0, "a filtered export carries nothing to drop");

// Careers and round detail landed correctly — and the two live by DIFFERENT sources, on purpose:
// careers count kill EVENTS (the log), while a round's line carries the scoreboard's totals
// (GREATEST-reconciled). Here the fixture's scoreboard says 7 but only 2 kills have log lines,
// so career = 2 and the foy line = 7. On an install with an untrimmed log the two agree; where
// CRCON pruned logs, the rounds keep the truth and careers reflect the surviving event record.
const alpha = await repo.players.findByPlatformId("76561198000000001");
const st1 = await repo.stats.get(alpha.id, s1.id);
eq(st1.kills, 2, "career kills = kill events, API-era + newly imported counted once each");
const rounds1 = await repo.matches.list(s1.id);
eq(rounds1.length, 2, "server 1 has its two rounds");
const foy = rounds1.find((m) => m.map === "foy_warfare");
// THE ABSOLUTE INSTANT, not just internal consistency: CRCON stored the naive timestamp
// "2021-03-01 01:00" MEANING 01:00 UTC. Run this rehearsal under any host timezone
// (TZ=America/New_York, TZ=Asia/Tokyo …) and this must still hold — the pg driver's habit of
// parsing naive timestamps in the host zone shifted every instant before the ::text casts.
eq(foy.startedAt, "2021-03-01T01:00:00.000Z", "imported instants are the UTC CRCON meant, on ANY host timezone");
eq(foy.alliedScore, 4, "the {Axis,Allied}→{axis,allied} translation held");
eq(foy.winner, "allies", "winner derived");
const foyLine = (await repo.matches.statsForMatch(foy.id)).find((l) => l.playerId === alpha.id);
eq(foyLine.kills, 7, "the round line carries the scoreboard's 7 (GREATEST over the log's count)");
eq(foyLine.combat, 250, "score buckets landed");
// The unit history became REAL role time: one entry (role 3) spanning the round's 3500s — not
// the "-1 unknown role" sentinel the API-era import had to settle for.
eq(JSON.stringify(foyLine.roleSeconds), JSON.stringify({ "3": 3500 }), "unit history → real role clocks");

// ── The proof: reconcile against the CRCON database ────────────────────────────────────────
const rep1 = await reconcile(crcon, repo, s1.id, 1);
console.log(formatReport(rep1));
if (!rep1.complete) throw new Error("reconciliation of server 1 is not COMPLETE");

// ── One-and-done: a second Apply changes nothing ───────────────────────────────────────────
const sum2 = await transformCrconArchive(repo, s1, by);
eq(sum2.kills, 0, "re-apply inserts no kills");
eq((await repo.stats.get(alpha.id, s1.id)).kills, 2, "career unchanged by re-apply");
const rep2 = await reconcile(crcon, repo, s1.id, 1);
if (!rep2.complete) throw new Error("still COMPLETE after re-apply");

// ── Server 2 imports independently, and the two never bleed ────────────────────────────────
const a2 = new ArchiveWriter(crconBackupFile(s2.id), true);
await exportServer({ pool: crcon, serverNumber: 2, archive: a2 });
await a2.close();
const sumB = await transformCrconArchive(repo, s2, by);
if (sumB.errors.length) throw new Error(`server-2 transform errors: ${sumB.errors.join(" | ")}`);
eq(sumB.matches, 1, "only server 2's FINISHED round imported — the open kursk round stayed out");
const rep3 = await reconcile(crcon, repo, s2.id, 2);
if (!rep3.complete) throw new Error("reconciliation of server 2 is not COMPLETE");
eq((await repo.crconSnapshot.importIntegrity(s1.id)).crossServerEvents, 0, "no cross-server contamination anywhere");
eq((await repo.matches.list(s1.id)).length, 2, "server 1 untouched by server 2's import");

// ── Scale & the batch boundary: 10,000 log lines through the keyset pagination ─────────────
// Exactly two FULL batches at the default 5,000 plus the empty terminal fetch — the boundary a
// tiny fixture never exercises — and the counts must come out exact, then reconcile COMPLETE.
await crcon.query(`INSERT INTO log_lines (event_time, type, player1_name, player1_steamid, player2_name, player2_steamid, weapon, raw, content, server, version, creation_time)
  SELECT timestamp '2021-04-01 00:00:00' + (i || ' seconds')::interval, 'KILL', 'Alpha', 1, 'Bravo', 2, 'M1 GARAND', 'raw', '', '3', 1,
         timestamp '2021-04-01 00:00:00' + (i || ' seconds')::interval
  FROM generate_series(1, 10000) AS g(i)`);
const s3 = await repo.servers.create({ name: "three", host: "127.0.0.1", port: 3, password: "x" });
const a3 = new ArchiveWriter(crconBackupFile(s3.id), true);
const counts3 = await exportServer({ pool: crcon, serverNumber: 3, archive: a3 });
await a3.close();
eq(counts3.log_kill, 10000, "keyset paging exported every row exactly once across the batch boundary");
const sum3 = await transformCrconArchive(repo, s3, by);
if (sum3.errors.length) throw new Error(`scale transform errors: ${sum3.errors.join(" | ")}`);
eq(sum3.kills, 10000, "all 10,000 kills applied");
const rep4 = await reconcile(crcon, repo, s3.id, 3);
if (!rep4.complete) throw new Error("scale reconciliation is not COMPLETE");
const alpha3 = await repo.players.findByPlatformId("76561198000000001");
eq((await repo.stats.get(alpha3.id, s3.id)).kills, 10000, "career counted every one, once");

await repo.close?.();
await crcon.end();
console.log("");
console.log("REHEARSAL OK — CRCON db → export → REAL Apply → reconcile COMPLETE, twice-applied unchanged, servers separated");
