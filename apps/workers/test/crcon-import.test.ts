import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepository } from "@app/db";
import { crconBackupFile } from "@app/shared";
import { entityKeyOf, rowsFrom, playerIdOf, hashKey } from "../src/crcon-import/stages.ts";
// From dist, not src: the class uses constructor parameter properties, which strip-types can't run.
import { ArchiveWriter } from "../dist/crcon-import/archive.js";

// Isolate the archive files this test writes (read by crconBackupFile at call time).
process.env.CRCON_BACKUP_DIR = mkdtempSync(join(tmpdir(), "crcon-bk-"));
process.env.CRCON_IMPORT_INTERVAL_MS = "0"; // read at import — no throttle in tests
const { runImportJob } = await import("../dist/crcon-import/runner.js"); // imported after env is set

/** Count archive lines per data type by streaming the file (mirrors how the app reads it). */
function archiveCounts(serverId: string): Record<string, number> {
  const file = crconBackupFile(serverId);
  if (!existsSync(file)) return {};
  const out: Record<string, number> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { const t = JSON.parse(s).dataType as string; out[t] = (out[t] ?? 0) + 1; } catch { /* skip */ }
  }
  return out;
}

test("rowsFrom: bare array, {result}, and {key:[...]}", () => {
  assert.equal(rowsFrom([{ a: 1 }, { a: 2 }]).length, 2);
  assert.equal(rowsFrom({ result: [{ a: 1 }] }).length, 1);
  assert.equal(rowsFrom({ players: [{ a: 1 }, { a: 2 }] }, "players").length, 2);
  assert.equal(rowsFrom({ result: { players: [{ a: 1 }] } }, "players").length, 1);
  assert.deepEqual(rowsFrom(null), []);
});

test("entityKeyOf: player types key by id, lists by id, keyless by content hash", () => {
  assert.equal(entityKeyOf("vip", { player_id: "76561198000000001" }), "76561198000000001");
  assert.equal(entityKeyOf("player_detail", { player: { steam_id_64: "222" } }), "222");
  assert.equal(entityKeyOf("blacklist", { id: 7, name: "Cheaters" }), "7");
  assert.equal(entityKeyOf("blacklist_record", { id: "rec-9" }), "rec-9");
  assert.equal(entityKeyOf("blacklist_record", { blacklist_id: "3", player_id: "5" }), "3:5");
  // keyless (standard message) → stable hash, identical content collapses
  const a = entityKeyOf("standard_message", { kind: "broadcast", message: "hi" });
  const b = entityKeyOf("standard_message", { kind: "broadcast", message: "hi" });
  assert.equal(a, b);
  assert.notEqual(a, entityKeyOf("standard_message", { kind: "broadcast", message: "bye" }));
});

test("flushed(): every appended row is on disk the moment it resolves", async () => {
  // The player_detail stage reads its pid list back out of the very file being written; rows
  // still sitting in the write stream's buffer would silently drop the tail of that list (seen
  // once as the retry-pass test flaking under full-battery I/O load). Enough rows that the
  // stream is certainly still buffering when the loop ends.
  const file = join(process.env.CRCON_BACKUP_DIR!, "flush-barrier.ndjson");
  const w = new ArchiveWriter(file, true);
  for (let i = 0; i < 5000; i++) {
    w.append({ dataType: "player", entityKey: String(i), raw: { player_id: String(i), pad: "x".repeat(200) } });
  }
  await w.flushed();
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 5000, "nothing may still be sitting in the stream buffer");
  await w.close();
});

test("playerIdOf + hashKey basics", () => {
  assert.equal(playerIdOf({ steam_id_64: "9" }), "9");
  assert.equal(playerIdOf({ player: { player_id: "8" } }), "8");
  assert.equal(playerIdOf({}), "");
  assert.equal(hashKey("x"), hashKey("x"));
});

/** A fake CRCON that serves paged history + lists, so we can drive a full pull end to end.
 *  `flags.failProfile` makes get_player_profile 500 for that player id until cleared — the retry
 *  tests flip it off between runs to simulate a transient CRCON error. */
function fakeCrcon(): Promise<{ server: Server; base: string; calls: string[]; flags: { failProfile: string | null; serverFilters: (string | null)[] } }> {
  const calls: string[] = [];
  const flags: { failProfile: string | null; serverFilters: (string | null)[] } = { failProfile: null, serverFilters: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    calls.push(url.pathname);
    const send = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result, failed: false })); };
    const page = Number(url.searchParams.get("page") ?? 1);
    if (url.pathname === "/api/get_player_profile" && flags.failProfile && url.searchParams.get("player_id") === flags.failProfile) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ failed: true, error: "boom" }));
    }
    switch (url.pathname) {
      case "/api/get_vip_ids": return send([{ player_id: "1", name: "Vip" }]);
      case "/api/get_bans": return send([{ player_id: "2", reason: "x", type: "perma" }]);
      case "/api/get_blacklists": return send([{ id: "10", name: "Cheaters" }]);
      case "/api/get_blacklist_records": return send({ records: url.searchParams.get("blacklist_id") === "10" && page === 1 ? [{ id: "r1", player_id: "3" }] : [] });
      case "/api/get_standard_broadcast_messages": return send(["welcome all"]);
      case "/api/get_standard_welcome_messages": return send([]);
      case "/api/get_standard_punishments_messages": return send([]);
      case "/api/get_status": return send({ name: "srv one", short_name: "S1", map: {}, current_players: 0, max_players: 100, server_number: 1 });
      case "/api/get_historical_logs": {
        // Record what filter each log stage sent — the multi-server separation guarantee.
        flags.serverFilters.push(url.searchParams.get("server_filter"));
        return send({ logs: [] });
      }
      case "/api/get_map_history": return send([{ id: "m1", name: "carentan" }]);
      case "/api/get_scoreboard_maps": return send({
        page, page_size: 25, total: 1,
        maps: page === 1 ? [{ id: "m1", map_name: "carentan_warfare", start: "2021-01-01T00:00:00Z", end: "2021-01-01T00:45:00Z", result: { allied: 3, axis: 2 }, player_stats: [{ player_id: "1", player: "Vip", kills: 5, combat: 100 }] }] : [],
      });
      case "/api/get_players_history": {
        const watched = url.searchParams.get("is_watched") === "true";
        if (watched) return send({ players: page === 1 ? [{ player_id: "1" }] : [] });
        // full history: two players on page 1, then empty
        return send({ players: page === 1 ? [{ player_id: "1", name: "Vip" }, { player_id: "2", name: "Banned" }] : [] });
      }
      case "/api/get_player_profile": return send({ player_id: url.searchParams.get("player_id"), sessions: [] });
      default: { res.writeHead(404); return res.end(JSON.stringify({ failed: true, error: "unknown" })); }
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, flags })));
}

test("runImportJob archives every data type, deduped, and finishes done", async () => {
  const { server, base, flags } = await fakeCrcon();
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "owner" });

    await runImportJob(repo, job.id);

    const finished = await repo.crconSnapshot.getJob(job.id);
    assert.equal(finished!.status, "done");

    const counts = archiveCounts(srv.id);
    assert.equal(counts.meta, 1, "the archive records WHICH server of the install it was pulled for");
    // Every log stage names the server — CRCON's server_filter defaults to the whole install,
    // and unfiltered pulls on a multi-server install are how two servers' histories got mixed.
    assert.equal(flags.serverFilters.length, 12, "all twelve log stages fetched");
    assert.ok(flags.serverFilters.every((f) => f === "1"), `every log request filtered to server 1 (got ${JSON.stringify([...new Set(flags.serverFilters)])})`);
    assert.equal(counts.vip, 1);
    assert.equal(counts.ban, 1);
    assert.equal(counts.blacklist, 1);
    assert.equal(counts.blacklist_record, 1);
    assert.equal(counts.standard_message, 1);
    assert.equal(counts.map_history, 1);
    assert.equal(counts.map_scoreboard, 1); // the round's full record: score + per-player rows
    assert.equal(counts.watchlist, 1);
    assert.equal(counts.player, 2);
    assert.equal(counts.player_detail, 2); // one profile per archived player

    // Re-driving a finished job is a no-op: every stage's cursor is done, so nothing re-pulls or
    // re-appends — the archive stays the same size.
    await repo.crconSnapshot.updateJob(job.id, { status: "running" });
    await runImportJob(repo, job.id);
    const again = archiveCounts(srv.id);
    assert.equal(again.player, 2);
    assert.equal(again.player_detail, 2);

    // A brand-new job (empty cursor) is a fresh re-pull: it TRUNCATES and rewrites the file, so the
    // archive is refreshed, not doubled.
    const job2 = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "owner" });
    await runImportJob(repo, job2.id);
    const repull = archiveCounts(srv.id);
    assert.equal(repull.player, 2); // not 4 — the old file was replaced, not appended to
    assert.equal(repull.player_detail, 2);
  } finally {
    server.close();
  }
});

test("paged stage ends on a short final page even when CRCON clamps overflow pages", async () => {
  // Regression: the player/watchlist pulls request page_size=500, but the end-of-data check once
  // compared against a fixed 100. A normal short last page (>=100, <500) then read as "not done",
  // and because CRCON clamps an out-of-range page to the last page (returns it again, not empty),
  // the stage re-fetched forever — counts/archive frozen, player_detail never reached.
  const players = Array.from({ length: 100 }, (_, i) => ({ player_id: String(1000 + i) }));
  let historyCalls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result, failed: false })); };
    switch (url.pathname) {
      case "/api/get_players_history": {
        if (url.searchParams.get("is_watched") === "true") return send({ players: [] });
        historyCalls++; // 100 players (< the requested 500) but CLAMPED: every page returns them all
        return send({ players });
      }
      case "/api/get_player_profile": return send({ player_id: url.searchParams.get("player_id") });
      default: return send([]); // vip/ban/blacklist/messages/map_history → empty
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "o" });
    await runImportJob(repo, job.id);
    const finished = (await repo.crconSnapshot.getJob(job.id))!;
    assert.equal(finished.status, "done");
    assert.equal(historyCalls, 1); // the short page ended the loop — no overflow re-fetch
    const counts = archiveCounts(srv.id);
    assert.equal(counts.player, 100);
    assert.equal(counts.player_detail, 100); // player_detail was actually reached and ran
  } finally {
    server.close();
  }
});

test("runImportJob refuses to run without an API key", async () => {
  const repo = await createRepository();
  const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
  const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: "https://x", apiKey: "", createdByName: "o" });
  await runImportJob(repo, job.id);
  assert.equal((await repo.crconSnapshot.getJob(job.id))!.status, "error");
});

test("a failing stage is skipped, not fatal — the pull still completes", async () => {
  // map_history 500s on every attempt; the pull should record it and finish `done` with the rest.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result, failed: false })); };
    if (url.pathname === "/api/get_map_history") { res.writeHead(500); return res.end("boom"); }
    if (url.pathname === "/api/get_vip_ids") return send([{ player_id: "1" }]);
    if (url.pathname === "/api/get_players_history") return send({ players: Number(url.searchParams.get("page")) === 1 && url.searchParams.get("is_watched") !== "true" ? [{ player_id: "1" }] : [] });
    if (url.pathname === "/api/get_player_profile") return send({ player_id: url.searchParams.get("player_id") });
    return send([]); // bans, blacklists, messages, watchlist → empty
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    // Fast client retries so the test isn't slow: 0 retries, 0 interval.
    process.env.CRCON_IMPORT_INTERVAL_MS = "0";
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "o" });
    await runImportJob(repo, job.id);
    const finished = (await repo.crconSnapshot.getJob(job.id))!;
    assert.equal(finished.status, "done"); // NOT error — the bad stage was skipped
    assert.ok(finished.errors.some((e) => e.startsWith("map_history:")), "records the skipped stage");
    const counts = archiveCounts(srv.id);
    assert.equal(counts.vip, 1); // stages after the failure still ran
    assert.equal(counts.player, 1);
    assert.equal(counts.player_detail, 1);
    assert.equal(counts.map_history ?? 0, 0); // the failed stage archived nothing
  } finally {
    server.close();
  }
});

test("an auth failure (401) stops the whole pull", async () => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end("nope"); });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    process.env.CRCON_IMPORT_INTERVAL_MS = "0";
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "BAD", createdByName: "o" });
    await runImportJob(repo, job.id);
    assert.equal((await repo.crconSnapshot.getJob(job.id))!.status, "error"); // fatal — bad key
  } finally {
    server.close();
  }
});

test("retry pass: failed profiles re-fetch via player_detail_retry, re-run stages don't duplicate", async () => {
  const { server, base, flags } = await fakeCrcon();
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s2", host: "127.0.0.1", port: 2, password: "x" });
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "owner" });

    // First pull: player 2's profile 500s → recorded as an error, everything else lands.
    flags.failProfile = "2";
    await runImportJob(repo, job.id);
    const after1 = await repo.crconSnapshot.getJob(job.id);
    assert.equal(after1!.status, "done");
    assert.ok(after1!.errors.some((e) => e.startsWith("player_profile 2:")));
    assert.equal(archiveCounts(srv.id).player_detail, 1); // only player 1 made it

    // What the API's retry route does: queue the failed pid, clear one finished stage (simulating
    // a stage-level failure / a newly added data type), wipe errors, flip back to running.
    flags.failProfile = null;
    const cursor = { ...after1!.cursor } as Record<string, unknown>;
    delete cursor.vip;
    cursor.player_detail_retry = { pids: ["2"], done: false };
    await repo.crconSnapshot.updateJob(job.id, { status: "running", cursor, errors: [] });
    await runImportJob(repo, job.id);

    const after2 = await repo.crconSnapshot.getJob(job.id);
    assert.equal(after2!.status, "done");
    assert.deepEqual(after2!.errors, []); // the retry succeeded — no lingering warning
    const counts = archiveCounts(srv.id);
    assert.equal(counts.player_detail, 2); // the missing profile was appended
    assert.equal(counts.vip, 1);           // re-run stage deduped against the file — no double row
    assert.equal(counts.player, 2);        // untouched stages untouched
  } finally {
    server.close();
  }
});

test("resume with a vanished archive file stops with an explicit error instead of silently shrinking", async () => {
  const { server, base } = await fakeCrcon();
  try {
    const repo = await createRepository();
    const srv = await repo.servers.create({ name: "s3", host: "127.0.0.1", port: 3, password: "x" });
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: base, apiKey: "K", createdByName: "owner" });
    // Cursor says work happened, but the archive file does not exist (lost volume / rebuilt host).
    await repo.crconSnapshot.updateJob(job.id, { status: "running", cursor: { vip: { done: true } } });
    await runImportJob(repo, job.id);
    const after = await repo.crconSnapshot.getJob(job.id);
    assert.equal(after!.status, "error");
    assert.ok(after!.errors.some((e) => /archive file is missing/.test(e)));
  } finally {
    server.close();
  }
});
