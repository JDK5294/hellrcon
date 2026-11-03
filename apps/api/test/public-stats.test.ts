/**
 * The public stats surface — slugs, the manifest, and the four scoreboard endpoints.
 *
 * What must never regress, in order of blast radius:
 *   1. only PUBLISHED servers exist on any public route, and one server's address is never a
 *      window into another server's rounds (the integer alias is install-wide);
 *   2. the published player identity is the PLATFORM id — a row whose internal id cannot be
 *      resolved is withheld, never emitted with an internal UUID in the player_id slot;
 *   3. absent data is null/empty, never an invention (the PlayerStatsType null policy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { buildScoreboardMap, foldKillWindow } from "../dist/streamer.js";
import { crconLineEncounters } from "../dist/crcon-stats.js";
import { publicHostView } from "../src/public-host.ts";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

async function anon(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/**
 * A published server with an address, plus a finished round with two players and a kill each.
 * `publicPlayerIds` is the platform-id sub-toggle; the tests that read identity opt in, because
 * the product default is names-only.
 */
async function publishedRound(repo: Awaited<ReturnType<typeof createRepository>>, publicPlayerIds = true) {
  const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
  await repo.servers.setStreamerMode(s.id, true);
  await repo.servers.setPublicProfile(s.id, { publicSlug: "alpha", publicName: "Alpha 24/7", publicPlayerIds });
  const [smith, jones] = await repo.players.upsertMany([
    { game: "hll", platform: "steam", platformId: "76561198000000001", name: "Smith", ts: "2026-08-01T09:00:00.000Z" },
    { game: "hll", platform: "steam", platformId: "76561198000000002", name: "Jones", ts: "2026-08-01T09:00:00.000Z" },
  ]);
  assert.ok(smith); assert.ok(jones);
  const match = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-08-01T10:00:00.000Z" });
  await repo.matches.bumpStat({ matchId: match.id, playerId: smith.id, serverId: s.id, playerName: "Smith", side: "allies", kills: 2 });
  await repo.matches.bumpStat({ matchId: match.id, playerId: jones.id, serverId: s.id, playerName: "Jones", side: "axis", deaths: 2 });
  await repo.events.insert([
    { serverId: s.id, ts: "2026-08-01T10:05:00.000Z", kind: "evt.kill", actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: jones.id, victimName: "Jones", weapon: "M1 GARAND", dedupeKey: "k1" },
    { serverId: s.id, ts: "2026-08-01T10:06:00.000Z", kind: "evt.kill", actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: jones.id, victimName: "Jones", weapon: "M1 GARAND", dedupeKey: "k2" },
  ]);
  await repo.matches.close(match.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: null });
  return { s, match, smith, jones };
}

test("the slug is validated, unique, reversible, and audited", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const a = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    const b = await repo.servers.create({ name: "Bravo", host: "10.0.0.2", port: 1, password: "x" });

    const set = await jf(`${base}/api/servers/${a.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "Nam", publicName: "Nam 24/7" }) });
    assert.equal(set.status, 200);
    assert.equal(set.body.server.publicSlug, "nam", "slugs are lowercased, not refused for case");
    assert.equal(set.body.server.publicName, "Nam 24/7");

    // Shape: no spaces, no leading hyphen, bounded. "api" reserved (it would shadow the API
    // mount); "stats" reserved (its short link on a dedicated hostname IS the site index).
    for (const bad of ["has space", "-lead", "x".repeat(41), "api", "stats", "ümlaut"]) {
      const r = await jf(`${base}/api/servers/${b.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: bad }) });
      assert.equal(r.status, 400, `"${bad}" must be refused`);
    }

    // Two servers on one address is corruption; the second write is a 409, not a takeover.
    const taken = await jf(`${base}/api/servers/${b.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "nam" }) });
    assert.equal(taken.status, 409);

    // Blank clears the address.
    const cleared = await jf(`${base}/api/servers/${a.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "" }) });
    assert.equal(cleared.body.server.publicSlug, null);

    // Signed out cannot name anything.
    assert.equal((await jf(`${base}/api/servers/${a.id}/public-profile`, { method: "POST", body: JSON.stringify({ publicSlug: "x" }) })).status, 401);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "server.public_profile"), "naming the public address is audited");
  });
});

test("the manifest lists only published servers with addresses, and teaches how to read them", async () => {
  await withServer(async (base, repo) => {
    const a = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    const b = await repo.servers.create({ name: "Bravo", host: "10.0.0.2", port: 1, password: "x" });
    const nam = await repo.servers.create({ name: "Nam", host: "10.0.0.3", port: 1, password: "x", game: "hllv" });
    await repo.servers.setStreamerMode(a.id, true);
    await repo.servers.setPublicProfile(a.id, { publicSlug: "alpha", publicName: "Alpha 24/7", publicPlayerIds: false });
    // b: published but never named — no address, so it cannot be listed.
    await repo.servers.setStreamerMode(b.id, true);
    // nam: named but NOT published — must not be listed either.
    await repo.servers.setPublicProfile(nam.id, { publicSlug: "nam", publicName: null, publicPlayerIds: false });

    const r = await anon(`${base}/api/public/servers`);
    assert.equal(r.status, 200);
    assert.equal(r.body.site.origin, null, "no public hostname set: the page names its own address");
    const servers = r.body.servers as any[];
    assert.deepEqual(servers.map((s) => s.slug), ["alpha"], "published+named only");
    assert.equal(servers[0].name, "Alpha 24/7", "the public name, not the staff label");
    // The projection is a fixed set of presentation fields — no host, no id, no credentials.
    assert.deepEqual(Object.keys(servers[0]).sort(), ["game", "name", "playerIds", "scoreFields", "sides", "slug", "squadLabel"]);
    assert.equal(servers[0].playerIds, false, "the manifest states whether ids are published — default names-only");
    assert.equal(servers[0].sides.length, 2, "descriptor sides ride along so the page needs no game table");

    // Publish the Vietnam server: its sides must be ITS OWN (US/NVA), same code path.
    await repo.servers.setStreamerMode(nam.id, true);
    const r2 = await anon(`${base}/api/public/servers`);
    const vn = (r2.body.servers as any[]).find((s) => s.slug === "nam");
    assert.ok(vn, "now listed");
    assert.notDeepEqual(vn.sides.map((x: any) => x.label), servers[0].sides.map((x: any) => x.label),
      "a Vietnam server teaches its own faction labels — the page hardcodes neither");
  });
});

test("the slug mount answers exactly like the id mount, and unpublished slugs are invisible", async () => {
  await withServer(async (base, repo) => {
    const { s } = await publishedRound(repo);
    const bySlug = await anon(`${base}/stats/alpha/api/get_map_history`);
    const byId = await anon(`${base}/s/${s.id}/api/get_map_history`);
    assert.equal(bySlug.status, 200);
    assert.deepEqual(bySlug.body.result, byId.body.result, "one handler, two addresses");
    assert.equal(bySlug.body.result[0].name, "carentan_warfare");

    // Unpublishing kills the slug address too — same uniform 404 as a slug that never existed.
    await repo.servers.setStreamerMode(s.id, false);
    const off = await anon(`${base}/stats/alpha/api/get_map_history`);
    const never = await anon(`${base}/stats/no-such/api/get_map_history`);
    assert.deepEqual({ status: off.status, error: off.body.error }, { status: never.status, error: never.body.error });
  });
});

/*
 * The bytes themselves, not a parsed copy: CRCON serializes with orjson, so key order, spacing and
 * number spelling are part of the contract. get_version is the smallest whole answer there is.
 */
test("get_version answers in CRCON's exact bytes, as release v12.3.0 does", async () => {
  await withServer(async (base, repo) => {
    await publishedRound(repo);
    const res = await fetch(`${base}/stats/alpha/api/get_version`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json", "Django's HttpResponse content type, no charset");
    assert.equal(await res.text(), '{"result":"v12.3.0","command":"get_version","arguments":null,"failed":false,"error":null,"forwards_results":null,"version":"v12.3.0"}');
  });
});

test("get_scoreboard_maps pages the rounds under CRCON's shape, with the integer alias as id", async () => {
  await withServer(async (base, repo) => {
    const { match } = await publishedRound(repo);
    const r = await anon(`${base}/stats/alpha/api/get_scoreboard_maps?page=1&page_size=10`);
    assert.equal(r.status, 200);
    assert.equal(r.body.failed, false);
    const page = r.body.result;
    assert.equal(page.total, 1);
    assert.equal(page.page, 1);
    const row = page.maps[0];
    assert.equal(row.id, match.seq, "the id a client hands back is the integer alias, not a UUID");
    assert.ok(Number.isInteger(row.id) && row.id > 0);
    assert.deepEqual(row.result, { allied: 5, axis: 0 });
    assert.equal(row.map.pretty_name.length > 0, true, "the layer object rides along for the page");
    assert.deepEqual(row.player_stats, [], "the list omits per-player rows; the detail endpoint carries them");
    // CRCON writes these rows out by hand in scoreboards.py: these eight keys, in this order, and
    // not the full record (no map_name, game_layout or cap_flips; get_map_scoreboard has those).
    assert.deepEqual(Object.keys(row), ["map", "id", "creation_time", "start", "end", "server_number", "player_stats", "result"]);
    assert.equal(r.body.arguments, null, "CRCON passes no arguments to this envelope");
  });
});

test("a round recorded from the match log is filed under CRCON's layer id, never refused", async () => {
  await withServer(async (base, repo) => {
    const { s } = await publishedRound(repo);
    // What our ingest stores: the MATCH START line's map text, as the game writes it. CRCON files
    // such a round under the layer it guesses from that text.
    const logged = await repo.matches.open({ serverId: s.id, map: "SAINTE-MÈRE-ÉGLISE Night Warfare", startedAt: "2026-08-01T12:00:00.000Z" });
    await repo.matches.close(logged.id, { endedAt: "2026-08-01T13:00:00.000Z", winner: null, alliedScore: 2, axisScore: 2, result: null });
    // One the worker filed as CRCON does at match start: the live layer, which the guess from
    // "CARENTAN Warfare" (carentan_warfare) would not have been.
    const filed = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T14:00:00.000Z" });
    await repo.matches.recordStart(filed.id, { map: "carentan_warfare_night", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.close(filed.id, { endedAt: "2026-08-01T15:00:00.000Z", winner: null, alliedScore: 2, axisScore: 2, result: null });

    const list = await anon(`${base}/stats/alpha/api/get_scoreboard_maps`);
    assert.equal(list.body.failed, false);
    // The newest round is filed when the next one starts, as CRCON files it: not listed yet.
    assert.deepEqual(list.body.result.maps.map((r: { map: { id: string } }) => r.map.id), ["stmereeglise_warfare_night", "carentan_warfare"]);
    const unfiled = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${filed.seq}`);
    assert.equal(unfiled.body.error, "No map for this ID");

    const detail = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${logged.seq}`);
    assert.equal(detail.body.failed, false);
    assert.equal(detail.body.result.map_name, "stmereeglise_warfare_night", "map_name is the filed id, not the log text");
    assert.equal(detail.body.result.map.pretty_name, "St. Mere Eglise Warfare (Night)");

    const history = await anon(`${base}/stats/alpha/api/get_map_history`);
    assert.deepEqual(history.body.result.map((e: { name: string }) => e.name), ["carentan_warfare_night", "stmereeglise_warfare_night", "carentan_warfare"]);
  });
});

test("get_map_scoreboard files the round's rows as CRCON's stats job does, over the round's log", async () => {
  await withServer(async (base, repo) => {
    const { match } = await publishedRound(repo);
    const r = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${match.seq}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.arguments, { map_id: String(match.seq) }, "the request's own arguments echo back as sent, a string, as CRCON's do");
    const stats = r.body.result.player_stats as any[];
    assert.equal(stats.length, 2);
    const smith = stats.find((p) => p.player === "Smith");
    const jones = stats.find((p) => p.player === "Jones");
    assert.ok(smith && jones);

    // Identity: the PUBLIC platform id, exactly what CRCON publishes — never an internal UUID.
    assert.equal(smith.player_id, "76561198000000001");
    assert.match(String(smith.player_id), /^\d+$/);
    assert.equal(smith.map_id, match.seq);

    // TimeWindowStats over the round's log: everyone a line names, counted from those lines.
    assert.equal(smith.kills, 2);
    assert.equal(smith.kills_streak, 2);
    assert.deepEqual(smith.weapons, { "M1 GARAND": 2 });
    assert.deepEqual(smith.most_killed, { "76561198000000002": 2 }, "nemeses by the other player's id");
    assert.deepEqual(jones.death_by, { "76561198000000001": 2 });
    assert.equal(jones.deaths_without_kill_streak, 2);
    assert.equal(jones.deaths_by_tk, 0);
    assert.equal(smith.team.side, "allies");
    // Both were first named five minutes in without a connect: counted from three minutes in, to
    // the round's end less CRCON's hundred-second cooldown.
    assert.deepEqual([smith.time_seconds, jones.time_seconds], [3320, 3320]);
    // Jones's lives run from that first sighting (10:03) to 10:05, then to 10:06.
    assert.deepEqual([jones.longest_life_secs, jones.shortest_life_secs], [120, 0]);

    // Encounters: ordered, seconds since round start, ids translated to platform ids.
    assert.equal(smith.encounters.length, 2);
    assert.deepEqual(smith.encounters[0], { action: "KILL", player_id: "76561198000000002", player_name: "Jones", ts: 300, weapon: "M1 GARAND" });

    // PlayerStats.to_dict, key for key, and `encounters` the view appends.
    assert.deepEqual(Object.keys(smith), ["id", "player_id", "player", "platform", "steaminfo", "map_id", "kills", "kills_by_type", "kills_streak",
      "deaths", "deaths_by_type", "deaths_without_kill_streak", "teamkills", "teamkills_streak", "deaths_by_tk", "deaths_by_tk_streak",
      "nb_vote_started", "nb_voted_yes", "nb_voted_no", "time_seconds", "kills_per_minute", "deaths_per_minute", "kill_death_ratio",
      "longest_life_secs", "shortest_life_secs", "combat", "offense", "defense", "support", "vehicle_kills", "vehicles_destroyed",
      "most_killed", "death_by", "weapons", "death_by_weapons", "team", "level", "kills_and_assists", "deaths_and_redeploys", "units", "encounters"]);
    // Smith never died, so no life ever closed: the int column's 0, as CRCON files it.
    assert.equal(smith.longest_life_secs, 0);
    // The vote counters are the GAME's vote-kick system and default to 0 the way CRCON's own
    // get_default_player_stats() does — this round's log carried no VOTESYS lines, which is a
    // count of zero rather than an absence of knowledge.
    assert.equal(smith.nb_vote_started, 0);
    assert.equal(smith.nb_voted_yes, 0);
    assert.equal(smith.nb_voted_no, 0);
    // No unit history was recorded for this round, so units are CRCON's empty default.
    assert.deepEqual(smith.units, []);
    // kills_by_type / deaths_by_type: CRCON's calc_weapon_type_usage over its own weapon table.
    assert.deepEqual(smith.kills_by_type, { infantry: 2 });
    assert.deepEqual(smith.deaths_by_type, {});
    assert.deepEqual(jones.deaths_by_type, { infantry: 2 });
    // detect_team without unit history: two kills with an allied rifle.
    assert.deepEqual(smith.team, { side: "allies", confidence: "strong", ratio: 100 });
    // On the wire the rates and that ratio are floats, as CRCON's float columns and round() give them.
    const text = await (await fetch(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${match.seq}`)).text();
    assert.ok(text.includes('"kills_per_minute":0.04,"deaths_per_minute":0.0,"kill_death_ratio":2.0,'), "round(2 / (3320 / 60), 2), and floats");
    assert.ok(text.includes('"team":{"side":"allies","confidence":"strong","ratio":100.0}'), "round()'s float");

    // Bad and foreign ids: refused without leaking whether the id exists elsewhere. CRCON answers
    // a failure with a 200 and `failed`, never an HTTP error, so a tool that checks the status
    // first behaves the same against either.
    const junk = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=nope`);
    assert.deepEqual([junk.status, junk.body.failed, junk.body.result, junk.body.arguments], [200, true, null, { map_id: "nope" }]);
    const other = await repo.servers.create({ name: "Bravo", host: "10.0.0.9", port: 1, password: "x" });
    const foreign = await repo.matches.open({ serverId: other.id, map: "foy_warfare", startedAt: "2026-08-02T10:00:00.000Z" });
    const cross = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${foreign.seq}`);
    assert.deepEqual([cross.status, cross.body.failed, cross.body.result, cross.body.error], [200, true, null, "No map for this ID"],
      "another server's round does not exist on this address: CRCON's own words for a missing round");
    const never = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=999999`);
    assert.deepEqual({ ...never.body, arguments: null }, { ...cross.body, arguments: null }, "and exactly as a round that never was");
  });
});

/*
 * A filed row is CRCON's _build_player_stat_dict: the game log's half from TimeWindowStats over the
 * round (start to its filed end — the next start where CRCON deferred the whistle — with a hundred
 * seconds' cooldown), the cache's half through _compute_temporary_stats, whose banked totals only
 * count when the last session's figure is not 0.
 */
test("get_map_scoreboard: the cache's half of a filed row, a deferred whistle's end, and names only", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    await repo.servers.setPublicProfile(s.id, { publicSlug: "alpha", publicName: null, publicPlayerIds: false });
    const [smith, jones] = await repo.players.upsertMany([
      { game: "hll", platform: "steam", platformId: "76561198000000001", name: "Smith", ts: "2026-08-01T09:00:00.000Z" },
      { game: "hll", platform: "steam", platformId: "76561198000000002", name: "Jones", ts: "2026-08-01T09:00:00.000Z" },
    ]);
    const at = (hm: string) => `2026-08-01T${hm}:00.000Z`;
    const a = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: at("10:00") });
    await repo.matches.recordStart(a.id, { map: "carentan_warfare", guessed: false, matchTime: 5400, initialMorale: null });
    await repo.events.insert([
      { serverId: s.id, ts: at("10:01"), kind: "evt.player.connected", actorPlayerId: smith!.id, actorName: "Smith", dedupeKey: "c1" },
      { serverId: s.id, ts: at("10:10"), kind: "evt.kill", actorPlayerId: smith!.id, actorName: "Smith", victimPlayerId: jones!.id, victimName: "Jones", weapon: "M1 GARAND", data: { playerTeam: "Allies", victimTeam: "Axis" }, dedupeKey: "k1" },
      { serverId: s.id, ts: at("10:30"), kind: "evt.player.disconnected", actorPlayerId: smith!.id, actorName: "Smith", dedupeKey: "d1" },
    ]);
    const unit = { ts: 60, team: 1, squad: 0, role: 0 };
    await repo.matches.saveCrconPlayers(a.id, [["76561198000000001", {
      combat: 0, p_combat: 50, offense: 10, p_offense: 5, defense: 0, p_defense: 0, support: 0, p_support: 0,
      vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0,
      kills_and_assists: 3, p_kills_and_assists: 1, deaths_and_redeploys: 0, p_deaths_and_redeploys: 0,
      p_unit: unit, units: [unit], level: 30, p_coord: { x: 0, y: 0, z: 0 }, has_spawned: true, names: ["Smith"], status: "offline",
    }]]);
    await repo.matches.close(a.id, { endedAt: at("11:00"), winner: "allies", alliedScore: 3, axisScore: 2, result: "`CARENTAN Warfare` ALLIED (3 - 2) AXIS" });
    await repo.matches.recordEnd(a.id, { deferred: true });
    await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: at("11:05") });

    const res = await fetch(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${a.seq}`);
    const raw = await res.text();
    const body = JSON.parse(raw);
    assert.equal(body.failed, false);
    assert.equal(body.result.end, "2026-08-01T11:05:00+00:00", "the whistle CRCON deferred ends the round at the next start");
    const [smithRow, jonesRow] = body.result.player_stats as [Record<string, any>, Record<string, any>];
    assert.deepEqual([smithRow.player, jonesRow.player], ["Smith", "Jones"]);
    assert.deepEqual([smithRow.player_id, jonesRow.player_id], [null, null], "a names-only server withholds ids");
    assert.deepEqual(smithRow.most_killed, { Jones: 1 }, "and keys nemeses by name");
    assert.deepEqual(smithRow.encounters, [{ action: "KILL", player_id: null, player_name: "Jones", ts: 600, weapon: "M1 GARAND" }]);
    assert.equal(smithRow.time_seconds, 1740, "connect to disconnect");
    assert.equal(jonesRow.time_seconds, 3620, "first named at 10:10: from 10:03 to the deferred end less 100 seconds");
    assert.deepEqual([smithRow.combat, smithRow.offense, smithRow.kills_and_assists, smithRow.level, smithRow.units], [0, 15, 4, 30, [unit]],
      "a bucket at 0 files 0 whatever it banked; the rest add their banked totals");
    assert.deepEqual([jonesRow.combat, jonesRow.level, jonesRow.units], [0, 0, []], "a player the cache never held files its defaults");
    assert.ok(raw.includes(`"team":{"side":"allies","confidence":"strong","ratio":100}`), "one side in the unit history: strong, and the int 100");
  });
});

/*
 * Player ids ship ON — CRCON parity, and the id is what a consuming tool joins on. But it stays a
 * SEPARATE switch from publishing, so one server can be made names-only without unpublishing it.
 * Both directions are silent on the page (nothing looks different either way), so both assertions
 * have to be on the wire.
 */
test("player ids publish by default, switch off cleanly, and each flip is audited", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    // Nothing here says anything about ids: this is what a server gets by simply being published.
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    assert.equal(s.publicPlayerIds, true, "a new server publishes ids — CRCON parity out of the box");

    const { match } = await publishedRound(repo);
    const on = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${match.seq}`);
    const smith = (on.body.result.player_stats as any[]).find((p) => p.player === "Smith");
    assert.equal(smith.player_id, "76561198000000001");
    assert.equal(smith.encounters[0].player_id, "76561198000000002", "including the nested copy");
    assert.equal((await anon(`${base}/api/public/servers`)).body.servers[0].playerIds, true, "and the manifest says so");
    const published = (await repo.servers.list()).find((x) => x.publicSlug === "alpha")!;

    // Switching to names-only: the id goes from the row AND from every encounter inside it.
    const off = await jf(`${base}/api/servers/${published.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "alpha", publicPlayerIds: false }) });
    assert.equal(off.status, 200);
    assert.equal(off.body.server.publicPlayerIds, false);
    const dark = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${match.seq}`);
    const hidden = (dark.body.result.player_stats as any[]).find((p) => p.player === "Smith");
    assert.equal(hidden.player_id, null);
    assert.deepEqual(hidden.encounters.map((e: any) => e.player_id), [null, null], "not through the back door either");
    assert.equal(hidden.player, "Smith", "the name stays — that is the whole point of the page");
    assert.equal(hidden.kills, 2, "and withholding identity costs no statistics");
    assert.equal((await anon(`${base}/api/public/servers`)).body.servers[0].playerIds, false, "the manifest follows");

    // A later write that says nothing about ids must not quietly flip them back on.
    const rename = await jf(`${base}/api/servers/${published.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "alpha", publicName: "Alpha Prime" }) });
    assert.equal(rename.body.server.publicPlayerIds, false, "omitted means unchanged, not the default");

    // Back on — reversible in both directions, which is why it is a switch.
    await jf(`${base}/api/servers/${published.id}/public-profile`, { method: "POST", headers: auth, body: JSON.stringify({ publicSlug: "alpha", publicPlayerIds: true }) });
    const lit = await anon(`${base}/stats/alpha/api/get_map_scoreboard?map_id=${match.seq}`);
    assert.equal((lit.body.result.player_stats as any[])[0].player_id, "76561198000000001");

    const audit = (await jf(`${base}/api/audit`, { headers: auth })).body.entries as any[];
    const summaries = audit.filter((e) => e.action === "server.public_profile").map((e) => String(e.summary));
    assert.ok(summaries.some((t) => /stopped publishing player ids/.test(t)), "the trail names the switch off");
    assert.ok(summaries.some((t) => /STARTED publishing player ids/.test(t)), "and the switch back on");
  });
});

test("the fold derives CRCON's streak fields from an ordered kill stream", () => {
  const at = (m: number) => `2026-08-01T10:${String(m).padStart(2, "0")}:00.000Z`;
  // Deliberately shuffled: repo reads return newest first, and the fold must not care.
  const fold = foldKillWindow([
    { ts: at(9), kind: "evt.kill", actorPlayerId: "B", actorName: "Bee", victimPlayerId: "A", victimName: "Ay", weapon: "K98" },
    { ts: at(1), kind: "evt.kill", actorPlayerId: "A", actorName: "Ay", victimPlayerId: "B", victimName: "Bee", weapon: "M1" },
    { ts: at(3), kind: "evt.kill", actorPlayerId: "A", actorName: "Ay", victimPlayerId: "B", victimName: "Bee", weapon: "M1" },
    { ts: at(5), kind: "evt.teamkill", actorPlayerId: "A", actorName: "Ay", victimPlayerId: "C", victimName: "Cee", weapon: "SATCHEL" },
    { ts: at(7), kind: "evt.kill", actorPlayerId: "A", actorName: "Ay", victimPlayerId: "B", victimName: "Bee", weapon: "M1" },
  ], "2026-08-01T10:00:00.000Z");

  const a = fold.get("A")!;
  assert.equal(a.killsStreak, 3, "kills 1,3,7 run unbroken (the TK does not break a KILL streak, a death does)");
  assert.equal(a.teamkillsStreak, 1);
  assert.equal(a.deathsWithoutKillStreak, 1, "the death at minute 9");
  assert.deepEqual(a.weapons, { M1: 3 }, "kills by weapon: the TK's satchel is not one, as CRCON counts KILL lines alone");
  assert.deepEqual(a.mostKilled, { Bee: 3 }, "a teamkill is not a kill on a nemesis board");

  const b = fold.get("B")!;
  assert.equal(b.deathsWithoutKillStreak, 3, "B dies at 1, 3 and 7 before the kill at 9 breaks the run");
  assert.equal(b.killsStreak, 1);

  const c = fold.get("C")!;
  assert.equal(c.deathsByTk, 1);
  assert.equal(c.deathsByTkStreak, 1);
});

/*
 * CRCON builds encounters in scoreboards.py's get_map_scoreboard from its KILL log lines, asked
 * for with exact_action=True, so a TEAM KILL line never reaches the list, and it writes the action
 * as "KILL" / "DEATH". A tool reading our wire must see exactly that.
 */
test("encounters go out as CRCON writes them: KILL and DEATH in capitals, team kills in nobody's list", () => {
  const T0 = Date.parse("2026-08-01T10:00:00.000Z");
  const line = (action: string, min: number, a: [string, string], v: [string, string], weapon: string) => ({
    action, timestampMs: T0 + min * 60_000, player_id_1: a[0], player_name_1: a[1], player_id_2: v[0], player_name_2: v[1], weapon, raw: "",
  });
  const lines = [
    line("KILL", 1, ["steam-A", "Ay"], ["steam-B", "Bee"], "M1"),
    line("TEAM KILL", 2, ["steam-A", "Ay"], ["steam-C", "Cee"], "SATCHEL"),
    line("KILL", 3, ["steam-B", "Bee"], ["steam-A", "Ay"], "K98"),
    line("KILL", 70, ["steam-B", "Bee"], ["steam-A", "Ay"], "K98"),
  ];
  const encounters = crconLineEncounters(lines, T0, T0 + 3_600_000, new Set(["steam-A", "steam-C"]));
  const a = encounters.get("steam-A")!;
  assert.deepEqual(a, [
    { action: "KILL", player_id: "steam-B", player_name: "Bee", ts: 60, weapon: "M1" },
    { action: "DEATH", player_id: "steam-B", player_name: "Bee", ts: 180, weapon: "K98" },
  ], "the team kill at 2:00 is not one of them, nor a kill after the round's end");
  assert.deepEqual(Object.keys(a[0]!), ["action", "player_id", "player_name", "ts", "weapon"], "key for key, in CRCON's order");
  assert.deepEqual(encounters.get("steam-C"), [], "nor on the victim's side");
  assert.equal(encounters.has("steam-B"), false, "only for the players the round's rows hold");
});

test("buildScoreboardMap: CRCON's Maps row, key for key, its result read off the whistle", () => {
  const round = {
    seq: 3, map: "FOY Warfare", crconMap: "foy_warfare", settledAt: "2026-08-01T11:00:01.000Z",
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T11:00:00.000Z",
    alliedScore: 3, axisScore: 2, result: "`FOY Warfare` ALLIED (1 - 4) AXIS",
    sectorLayout: ["a", "b", "c", "d", "e"], capFlips: [[30, 2, 2], [3605, 1, 4]] as [number, number, number][], moraleHistory: [],
    crconInitialMorale: 0, matchTime: 5400,
  };
  const row = buildScoreboardMap(round, "2026-08-01T11:05:00.000Z", "hll", 1, []) as Record<string, any>;
  assert.deepEqual(Object.keys(row), ["id", "creation_time", "start", "end", "server_number", "map_name", "result", "game_layout", "cap_flips", "morale_history", "initial_morale", "match_time", "player_stats", "map"],
    "Maps.to_dict(with_stats=True) in its order, then the map the view appends");
  assert.deepEqual([row.creation_time, row.start, row.end], ["2026-08-01T11:05:00", "2026-08-01T10:00:00+00:00", "2026-08-01T11:00:00+00:00"],
    "a naive creation time (filed as the next round started); aware start and end");
  assert.deepEqual(row.result, { axis: 4, allied: 1 }, "the whistle's score, not the last sample — axis first");
  assert.deepEqual(row.cap_flips, [{ allied_score: 2, axis_score: 2, ts: 30 }, { allied_score: 1, axis_score: 4, ts: 3605 }], "unclamped, as CRCON's column keeps it");
  assert.deepEqual(row.game_layout, { requested: ["a", "b", "c", "d", "e"], set: ["a", "b", "c", "d", "e"] }, "what CRCON writes for a layout chosen by name");
  // No whistle at all (superseded by the next start): CRCON files 2 - 2.
  assert.deepEqual((buildScoreboardMap({ ...round, result: null }, "2026-08-01T11:05:00.000Z", "hll", 1, []) as any).result, { axis: 2, allied: 2 });
  // An end CRCON left to the next start is that start.
  assert.equal((buildScoreboardMap({ ...round, crconEndDeferred: true }, "2026-08-01T11:05:00.000Z", "hll", 1, []) as any).end, "2026-08-01T11:05:00+00:00");
  // An imported round carries CRCON's own result: its scores, or the import's summary, or none.
  const imported = { ...round, crconMap: null, settledAt: null };
  assert.deepEqual((buildScoreboardMap(imported, null, "hll", 1, []) as any).result, { axis: 2, allied: 3 });
  assert.deepEqual((buildScoreboardMap({ ...imported, alliedScore: null, axisScore: null, result: "AXIS (0 - 5)" }, null, "hll", 1, []) as any).result, { axis: 5, allied: 0 });
  assert.equal((buildScoreboardMap({ ...imported, alliedScore: null, axisScore: null, result: null }, null, "hll", 1, []) as any).result, null);
});

/*
 * The dedicated public hostname: what exists there and what does not. Secrecy of the ADMIN
 * address is the point — a stats link must be shareable without revealing where the panel lives,
 * which also means the hostname players hold serves no login endpoint to probe.
 */
test("publicHostView: the stats hostname serves the public surface and nothing else", () => {
  const HOST = "stats.example.com";
  // No host configured, or the admin host: everything passes untouched.
  assert.deepEqual(publicHostView("panel.example.com", "/api/auth/login", null), { allowed: true, path: "/api/auth/login" });
  assert.deepEqual(publicHostView("panel.example.com", "/api/auth/login", HOST), { allowed: true, path: "/api/auth/login" });

  // On the stats host: the whole authed API — the login endpoint above all — does not exist.
  assert.equal(publicHostView(HOST, "/api/auth/login", HOST).allowed, false);
  assert.equal(publicHostView(HOST, "/api/servers", HOST).allowed, false);
  assert.equal(publicHostView(`${HOST}:443`, "/api/servers", HOST).allowed, false, "a port suffix does not dodge the gate");
  assert.equal(publicHostView(HOST.toUpperCase(), "/api/servers", HOST).allowed, false, "nor does case");

  // The public surface passes: manifest, both API mounts, the page's own paths, assets.
  for (const ok of ["/api/public/servers", "/stats/nam/api/get_public_info", "/s/abc/api/get_version", "/stats/nam", "/_next/static/x.js", "/game/hll/maps/foy.webp"]) {
    assert.equal(publicHostView(HOST, ok, HOST).allowed, true, `${ok} must exist on the stats host`);
    assert.equal(publicHostView(HOST, ok, HOST).path, ok, `${ok} is not rewritten`);
  }

  // File requests outside the asset prefixes do NOT exist there — /index.html IS the panel's
  // login shell, /brand/* is the panel's identity, and serving either on the players' hostname
  // is exactly the leak the hostname exists to prevent.
  for (const leak of ["/index.html", "/404.html", "/index.txt", "/brand/logo.svg", "/favicon.ico"]) {
    assert.equal(publicHostView(HOST, leak, HOST).allowed, false, `${leak} must not be served on the stats host`);
  }

  // Short links fold under /stats — this is what makes stats.example.com/nam work.
  assert.deepEqual(publicHostView(HOST, "/", HOST), { allowed: true, path: "/stats" });
  assert.deepEqual(publicHostView(HOST, "/nam", HOST), { allowed: true, path: "/stats/nam" });
  assert.deepEqual(publicHostView(HOST, "/nam/games", HOST), { allowed: true, path: "/stats/nam/games" });
  assert.deepEqual(publicHostView(HOST, "/nam/api/get_public_info", HOST), { allowed: true, path: "/stats/nam/api/get_public_info" });
});

test("on the wire: the stats hostname 404s the admin API and answers short stats paths", async () => {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null, publicStatsHost: "stats.test", publicStatsOrigin: "https://stats.test", publicStatsName: "Lynx" });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  // fetch() refuses a caller-set Host header, so this test speaks raw http.
  const raw = (path: string, host: string) => new Promise<{ status: number; body: any; type: string | undefined }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body: (() => { try { return JSON.parse(data); } catch { return data; } })() }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const { s } = await publishedRound(repo);

    // The login endpoint does not exist on the hostname players hold…
    assert.equal((await raw("/api/auth/status", "stats.test")).status, 404);
    // …while the same request on the admin host answers normally.
    assert.equal((await raw("/api/auth/status", "panel.test")).status, 200);

    // Short paths reach the public API: stats.test/alpha/api/... is the tool base that works.
    const short = await raw("/alpha/api/get_map_history", "stats.test");
    assert.equal(short.status, 200);
    assert.equal(short.body.failed, false);
    assert.equal(short.body.result[0].name, "carentan_warfare");

    // And the manifest (the one /api path that exists there) still answers.
    assert.equal((await raw("/api/public/servers", "stats.test")).status, 200);
    // It names the public address on both hosts: a link copied from the stats page opened on the
    // panel's host must carry it, never the admin hostname.
    for (const host of ["stats.test", "panel.test"]) {
      assert.equal((await raw("/api/public/servers", host)).body.site.origin, "https://stats.test", `on ${host}`);
    }

    // A saved stats page is its own home-screen app, and turns with the phone. Its start and scope
    // are the whole hostname players hold, and /stats on the panel's, never the staff sign-in.
    const app = await raw("/api/public/webmanifest", "stats.test");
    assert.equal(app.status, 200);
    assert.equal(app.type, "application/manifest+json");
    assert.deepEqual([app.body.orientation, app.body.display, app.body.start_url, app.body.scope, app.body.id], ["any", "standalone", "/", "/", "/"]);
    assert.deepEqual([app.body.name, app.body.short_name], ["Lynx Stats", "Lynx"], "named for the community, as the page's own header is");
    const onPanel = await raw("/api/public/webmanifest", "panel.test");
    assert.deepEqual([onPanel.body.orientation, onPanel.body.start_url, onPanel.body.scope, onPanel.body.id], ["any", "/stats", "/stats", "/stats"]);

    // The listing carries the shareable origin for the Connections card.
    void s;
  } finally {
    server.close();
  }
});

/*
 * The two live scoreboards are CRCON's LiveStats and TimeWindowStats (crcon-stats.ts): the first
 * lists who is connected, over each one's current session; the second lists whom the current
 * round's log names, from the round's start. Both lay the round's player cache over the rows it
 * holds. Everything here is relative to now, as the endpoints are.
 */
test("live scoreboards: CRCON's LiveStats and TimeWindowStats over the log, the round's cache laid over", async () => {
  const { FakeHllServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    try {
      fake.players = [{ iD: "76561198000000001", name: "Smith", platform: "steam" }, { iD: "76561198000000002", name: "Jones", platform: "epic" }];
      const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
      await repo.servers.setStreamerMode(s.id, true);
      await repo.servers.setPublicProfile(s.id, { publicSlug: "alpha", publicName: null, publicPlayerIds: true });
      const [smith, jones] = await repo.players.upsertMany([
        { game: "hll", platform: "steam", platformId: "76561198000000001", name: "Smith", ts: "2026-08-01T09:00:00.000Z" },
        { game: "hll", platform: "epic", platformId: "76561198000000002", name: "Jones", ts: "2026-08-01T09:00:00.000Z" },
      ]);
      const start = Math.floor(Date.now() / 1000) * 1000 - 600_000;
      const at = (sec: number) => new Date(start + sec * 1000).toISOString();
      const match = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: at(0) });
      await repo.matches.recordStart(match.id, { map: "carentan_warfare", guessed: false, matchTime: 5400, initialMorale: null });
      await repo.sessions.open(smith!.id, s.id, at(10));
      const kill = (sec: number, a: typeof smith, v: typeof smith, key: string) => ({
        serverId: s.id, ts: at(sec), kind: "evt.kill", actorPlayerId: a!.id, actorName: a!.name, victimPlayerId: v!.id, victimName: v!.name,
        weapon: "M1 GARAND", data: { playerTeam: a === smith ? "Allies" : "Axis", victimTeam: a === smith ? "Axis" : "Allies" }, dedupeKey: key,
      });
      await repo.events.insert([
        { serverId: s.id, ts: at(10), kind: "evt.player.connected", actorPlayerId: smith!.id, actorName: "Smith", dedupeKey: "c1" },
        kill(60, smith, jones, "k1"), kill(120, smith, jones, "k2"), kill(200, jones, smith, "k3"),
      ]);
      const unit = { ts: 30, team: 1, squad: 0, role: 0 };
      await repo.matches.saveCrconPlayers(match.id, [["76561198000000001", {
        combat: 10, p_combat: 5, offense: 1, p_offense: 0, defense: 2, p_defense: 0, support: 3, p_support: 0,
        vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0,
        kills_and_assists: 4, p_kills_and_assists: 0, deaths_and_redeploys: 1, p_deaths_and_redeploys: 0,
        p_unit: unit, units: [unit], level: 20, p_coord: { x: 0, y: 0, z: 0 }, has_spawned: true, names: ["Smith"], status: "online",
      }]]);

      const gameRes = await fetch(`${base}/stats/alpha/api/get_live_game_stats`);
      const gameRaw = await gameRes.text();
      const game = JSON.parse(gameRaw);
      assert.equal(game.failed, false);
      assert.deepEqual(Object.keys(game.result), ["snapshot_timestamp", "stats", "refresh_interval_sec"], "the dict CRCON's loop pickles, in its order");
      assert.match(gameRaw, /"snapshot_timestamp":\d+\.\d+,/, "an epoch float, not a date");
      assert.equal(game.result.refresh_interval_sec, 5);
      const [gs, gj] = game.result.stats as [Record<string, any>, Record<string, any>];
      assert.deepEqual([gs.player, gs.kills, gs.deaths, gj.player, gj.kills, gj.deaths], ["Smith", 2, 1, "Jones", 1, 2], "everyone the round's log names, first named first");
      assert.ok(Math.abs(gs.time_seconds - 590) <= 3, `from the connect to now: ${gs.time_seconds}`);
      assert.ok(Math.abs(gj.time_seconds - 420) <= 3, `a first sighting counts from three minutes in: ${gj.time_seconds}`);
      assert.deepEqual([gs.longest_life_secs, gs.shortest_life_secs, gs.last_spawn], [190, 0, at(200).replace(".000Z", "+00:00")]);
      assert.deepEqual(gs.most_killed, { "76561198000000002": 2 }, "nemeses by id");
      assert.deepEqual(Object.keys(gs).slice(-8), ["team", "level", "vehicles_destroyed", "vehicle_kills", "kills_and_assists", "deaths_and_redeploys", "faction", "status"],
        "the cache's overlay: no id, map_id or units, faction and status on the end");
      assert.deepEqual([gs.team, gs.faction, gs.status, gs.combat, gs.level, "id" in gs], ["allies", "us", "online", 15, 20, false]);
      assert.deepEqual([gj.id, gj.map_id, gj.team, gj.units, gj.platform], [0, 0, null, [], "epic"], "not in the cache: the defaults, the stored platform");

      const boardRes = await fetch(`${base}/stats/alpha/api/get_live_scoreboard`);
      const boardRaw = await boardRes.text();
      const board = JSON.parse(boardRaw);
      assert.equal(board.command, "live_scoreboard");
      assert.deepEqual(board.error, [null]);
      assert.deepEqual(Object.keys(board.result), ["snapshot_timestamp", "refresh_interval_sec", "stats"]);
      assert.match(boardRaw, /"snapshot_timestamp":\d+\.\d+,/, "an epoch float here too");
      const [bs, bj] = board.result.stats as [Record<string, any>, Record<string, any>];
      assert.deepEqual([bs.player, bs.kills, bs.deaths, bs.platform, bj.player, bj.kills, bj.time_seconds, bj.last_spawn], ["Smith", 2, 1, "steam", "Jones", 0, 0, null],
        "the connected, in the game's order, over their sessions: Jones has none");
      assert.ok(Math.abs(bs.time_seconds - 590) <= 3);
      assert.deepEqual([bs.team, bs.faction, bs.status, bs.combat, "id" in bs], ["allies", "us", "online", 15, false], "the round's cache laid over the connected too");
      assert.ok(boardRaw.includes(`"player":"Jones","platform":"epic","steaminfo":null,"map_id":0,"kills":0,`), boardRaw);
      assert.ok(boardRaw.includes(`"time_seconds":0,"last_spawn":null,"kills_per_minute":0,"deaths_per_minute":0,"kill_death_ratio":0,`), "no lines read: the rates stay the int 0");
    } finally {
      fake.close();
    }
  });
});

/*
 * The round's GAME LOG — our own /api/public/<slug>/log/<id>: start and end, kills, team kills,
 * connects, disconnects and team switches, in order. Names only, never chat (a player's words are
 * not a stat), nothing from outside the round's window, and the same 404 rules as the report.
 */
test("the round's game log is public, in order, names only, and carries no chat", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith, jones } = await publishedRound(repo, false);
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-01T09:59:00.000Z", kind: "evt.player.connected", actorPlayerId: smith.id, actorName: "Early Bird", dedupeKey: "before" },
      { serverId: s.id, ts: "2026-08-01T10:01:00.000Z", kind: "evt.player.connected", actorPlayerId: jones.id, actorName: "Jones", dedupeKey: "c1" },
      { serverId: s.id, ts: "2026-08-01T10:02:00.000Z", kind: "evt.player.teamSwitched", actorPlayerId: jones.id, actorName: "Jones", data: { from: "Allies", to: "Axis", swapFrom: "Allies", swapCount: 1 }, dedupeKey: "ts1" },
      { serverId: s.id, ts: "2026-08-01T10:03:00.000Z", kind: "evt.chat.team", actorPlayerId: jones.id, actorName: "Jones", data: { message: "a private remark" }, dedupeKey: "chat1" },
      { serverId: s.id, ts: "2026-08-01T10:07:00.000Z", kind: "evt.teamkill", actorPlayerId: jones.id, actorName: "Jones", victimPlayerId: smith.id, victimName: "Smith", weapon: "MP40", dedupeKey: "tk1" },
      { serverId: s.id, ts: "2026-08-01T10:50:00.000Z", kind: "evt.player.disconnected", actorPlayerId: jones.id, actorName: "Jones", dedupeKey: "d1" },
      { serverId: s.id, ts: "2026-08-01T11:05:00.000Z", kind: "evt.kill", actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: jones.id, victimName: "Next Round", weapon: "M1 GARAND", dedupeKey: "after" },
    ]);

    const r = await anon(`${base}/api/public/alpha/log/${match.seq}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const log = r.body.log;
    assert.equal(log.start, "2026-08-01T10:00:00.000Z");
    assert.equal(log.end, "2026-08-01T11:00:00.000Z");
    assert.equal(log.truncated, false);
    assert.deepEqual(log.lines.map((l: { t: number; kind: string }) => [l.t, l.kind]), [
      [0, "evt.match.started"],
      [60, "evt.player.connected"],
      [120, "evt.player.teamSwitched"],
      [300, "evt.kill"],
      [360, "evt.kill"],
      [420, "evt.teamkill"],
      [3000, "evt.player.disconnected"],
      [3600, "evt.match.ended"],
    ], "the round's own lines, in order, between its start and its end");
    assert.deepEqual(log.lines[2], { t: 120, kind: "evt.player.teamSwitched", who: "Jones", from: "Allies", to: "Axis", swapFrom: "Allies", swapCount: 1 });
    assert.deepEqual(log.lines[5], { t: 420, kind: "evt.teamkill", who: "Jones", whom: "Smith", weapon: "MP40" });
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("private remark") && !raw.includes("evt.chat"), "no chat crosses the public wire");
    assert.ok(!raw.includes(smith.id) && !raw.includes(jones.id), "no internal id either");
    assert.ok(!raw.includes("Early Bird") && !raw.includes("Next Round"), "nothing from outside the round's window");

    // The same uniform 404 as the report.
    assert.equal((await anon(`${base}/api/public/alpha/log/current`)).status, 404, "no round in play");
    assert.equal((await anon(`${base}/api/public/nope/log/${match.seq}`)).status, 404);
    const other = await repo.servers.create({ name: "Private", host: "10.0.0.2", port: 1, password: "x" });
    const foreign = await repo.matches.open({ serverId: other.id, map: "foy_warfare", startedAt: "2026-08-01T12:00:00.000Z" });
    assert.equal((await anon(`${base}/api/public/alpha/log/${foreign.seq}`)).status, 404, "another server's round is invisible here");
  });
});

/*
 * The admin camera is the one piece of moderation the public log shows, so players can see who
 * watched and when. Which way the admin went is the parser's word (`entered`), and only that
 * crosses: never the line's own words or the admin's id. A camera line that says neither way is
 * left out rather than shown as one or the other.
 */
test("the round's game log shows the admin camera, in and out, by name only", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith } = await publishedRound(repo, false);
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-01T10:04:00.000Z", kind: "evt.admin.camera", actorPlayerId: smith.id, actorName: "Admin Lynx", data: { entered: true, message: "Entered Admin Camera" }, dedupeKey: "cam1" },
      { serverId: s.id, ts: "2026-08-01T10:05:00.000Z", kind: "evt.admin.camera", actorPlayerId: smith.id, actorName: "Admin Lynx", data: { entered: null, message: "Fiddled With Camera" }, dedupeKey: "cam2" },
      { serverId: s.id, ts: "2026-08-01T10:06:30.000Z", kind: "evt.admin.camera", actorPlayerId: smith.id, actorName: "Admin Lynx", data: { entered: false, message: "Left Admin Camera" }, dedupeKey: "cam3" },
    ]);

    const r = await anon(`${base}/api/public/alpha/log/${match.seq}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cam = r.body.log.lines.filter((l: { kind: string }) => l.kind === "evt.admin.camera");
    assert.deepEqual(cam, [
      { t: 240, kind: "evt.admin.camera", who: "Admin Lynx", entered: true },
      { t: 390, kind: "evt.admin.camera", who: "Admin Lynx", entered: false },
    ], "in, then out, by name; the line that says neither way is left out");
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("Admin Camera") && !raw.includes("Fiddled"), "never the line's own words");
    assert.ok(!raw.includes(smith.id), "never the admin's id");
  });
});

/*
 * A busy round has thousands of lines, and every fold over it (the game log, the report, the
 * scoreboard rows) reads the round's whole window. The paged event read stops at 500 rows, which
 * once cut every one of them to a round's last few minutes without a word.
 */
test("a busy round's game log and report read every line, past one page of 500", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith, jones } = await publishedRound(repo, false);
    const t0 = Date.parse("2026-08-01T10:07:00.000Z");
    await repo.events.insert(Array.from({ length: 700 }, (_, i) => ({
      serverId: s.id, ts: new Date(t0 + i * 4000).toISOString(), kind: "evt.kill",
      actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: jones.id, victimName: "Jones", weapon: "M1 GARAND", dedupeKey: `busy${i}`,
    })));
    const log = (await anon(`${base}/api/public/alpha/log/${match.seq}`)).body.log;
    assert.equal(log.lines.filter((l: { kind: string }) => l.kind === "evt.kill").length, 702);
    assert.equal(log.truncated, false);
    const report = (await anon(`${base}/api/public/alpha/report/${match.seq}`)).body.report;
    assert.equal(report.players["Smith"].timeline.length, 702, "every kill is on the killer's timeline");
  });
});

/*
 * The round REPORT — our own /api/public/<slug>/report/<id> beside the manifest, NOT a CRCON
 * endpoint (those stay byte-for-byte). What must hold: name-keyed players, no internal id
 * anywhere in the body, the same 404 for missing/unpublished/foreign as every public route,
 * and `current` answering only while a round is actually open.
 */
test("the round report is public, name-keyed, and never leaks an internal id", async () => {
  await withServer(async (base, repo) => {
    const { match, smith, jones } = await publishedRound(repo, false);
    // The round's score series, as the worker records them off the player cache.
    await repo.matches.appendScoreSeries(match.id, [{ platformId: smith.platformId, sec: 120, combat: 40, offense: 0, defense: 20, support: 5 }]);
    await repo.matches.appendScoreSeries(match.id, [{ platformId: smith.platformId, sec: 180, combat: 80, offense: 0, defense: 20, support: 5 }]);

    const r = await anon(`${base}/api/public/alpha/report/${match.seq}`);
    assert.equal(r.status, 200);
    const rep = r.body.report;
    assert.equal(rep.complete, true);
    assert.ok(rep.players["Smith"], "players are keyed by display name");
    assert.deepEqual(rep.players["Smith"].timeline[0], [300, "k", "Jones", "M1 GARAND"],
      "the personal timeline crosses as [secs, kind, other, weapon] tuples");
    assert.deepEqual(rep.players["Smith"].scores, [[120, 40, 0, 20, 5], [180, 80, 0, 20, 5]],
      "and the score charts' points as [secs, combat, offense, defense, support]");
    assert.equal("scores" in rep.players["Jones"], false, "a player with no series has none");
    assert.equal(rep.players["Smith"].killsStreak, 2);
    const kills = rep.awards.find((a: { id: string }) => a.id === "kills");
    assert.equal(kills?.playerName, "Smith");
    assert.equal("playerId" in (kills ?? {}), false, "awards carry names only on the public wire");
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes(smith.id) && !raw.includes(jones.id), "no internal id crosses the public wire");

    // `current` with no open round, an unknown slug, and a foreign seq all answer the same 404.
    assert.equal((await anon(`${base}/api/public/alpha/report/current`)).status, 404);
    assert.equal((await anon(`${base}/api/public/nope/report/${match.seq}`)).status, 404);
    const other = await repo.servers.create({ name: "Private", host: "10.0.0.2", port: 1, password: "x" });
    const foreign = await repo.matches.open({ serverId: other.id, map: "foy_warfare", startedAt: "2026-08-01T12:00:00.000Z" });
    await repo.matches.close(foreign.id, { endedAt: "2026-08-01T13:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    assert.equal((await anon(`${base}/api/public/alpha/report/${foreign.seq}`)).status, 404,
      "another server's round is invisible through this address");

    // A live round answers under `current` — honestly incomplete until its first kill lands.
    const live = await repo.matches.open({ serverId: (await repo.servers.list()).find((x) => x.publicSlug === "alpha")!.id, map: "foy_warfare", startedAt: "2026-08-01T14:00:00.000Z" });
    const now = await anon(`${base}/api/public/alpha/report/current`);
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.equal(now.body.report.complete, false, `no kills yet, no charts (round ${live.id})`);
  });
});

/*
 * Two accounts, one display name, one round — legal in the game, and fatal to a name-keyed map.
 * End to end: neither is published under that name (publishing one would put their round on the
 * other's scoreboard row), everyone else on the round is untouched, and the wire names the
 * collision so the page can explain the gap instead of just having one.
 */
test("a name two players wore is published for neither, and the wire says so", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith } = await publishedRound(repo, false);
    const [twinA, twinB] = await repo.players.upsertMany([
      { game: "hll", platform: "steam", platformId: "76561198000000003", name: "Nemesis", ts: "2026-08-01T09:00:00.000Z" },
      { game: "hll", platform: "steam", platformId: "76561198000000004", name: "Nemesis", ts: "2026-08-01T09:00:00.000Z" },
    ]);
    assert.ok(twinA); assert.ok(twinB);
    await repo.matches.bumpStat({ matchId: match.id, playerId: twinA.id, serverId: s.id, playerName: "Nemesis", side: "allies", kills: 1 });
    await repo.matches.bumpStat({ matchId: match.id, playerId: twinB.id, serverId: s.id, playerName: "Nemesis", side: "axis", kills: 1 });
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-01T10:07:00.000Z", kind: "evt.kill", actorPlayerId: twinA.id, actorName: "Nemesis", victimPlayerId: twinB.id, victimName: "Nemesis", weapon: "M1 GARAND", dedupeKey: "k3" },
      { serverId: s.id, ts: "2026-08-01T10:08:00.000Z", kind: "evt.kill", actorPlayerId: twinB.id, actorName: "Nemesis", victimPlayerId: twinA.id, victimName: "Nemesis", weapon: "MG42", dedupeKey: "k4" },
    ]);

    const rep = (await anon(`${base}/api/public/alpha/report/${match.seq}`)).body.report;
    assert.equal(rep.players["Nemesis"], undefined, "neither twin is published under the shared name");
    assert.deepEqual(rep.sharedNames, ["Nemesis"], "the wire owns up to the collision by name");
    assert.equal(rep.players["Smith"]?.timeline.length, 2, "the rest of the round is unaffected");
    const raw = JSON.stringify(rep);
    assert.ok(!raw.includes(twinA.id) && !raw.includes(twinB.id) && !raw.includes(smith.id), "and still no internal id crosses");
  });
});

/*
 * Two accounts, one display name, one round — legal in the game, and fatal to a name-keyed map.
 * End to end: neither is published under that name (publishing one would put their round on the
 * other's scoreboard row), everyone else on the round is untouched, and the wire names the
 * collision so the page can explain the gap instead of just having one.
 */
test("a name two players wore is published for neither, and the wire says so", async () => {
  await withServer(async (repoBase, repo) => {
    const { s, match } = await publishedRound(repo, false);
    const [twinA, twinB] = await repo.players.upsertMany([
      { game: "hll", platform: "steam", platformId: "76561198000000003", name: "Nemesis", ts: "2026-08-01T09:00:00.000Z" },
      { game: "hll", platform: "steam", platformId: "76561198000000004", name: "Nemesis", ts: "2026-08-01T09:00:00.000Z" },
    ]);
    assert.ok(twinA); assert.ok(twinB);
    await repo.matches.bumpStat({ matchId: match.id, playerId: twinA.id, serverId: s.id, playerName: "Nemesis", side: "allies", kills: 1 });
    await repo.matches.bumpStat({ matchId: match.id, playerId: twinB.id, serverId: s.id, playerName: "Nemesis", side: "axis", kills: 1 });
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-01T10:07:00.000Z", kind: "evt.kill", actorPlayerId: twinA.id, actorName: "Nemesis", victimPlayerId: twinB.id, victimName: "Nemesis", weapon: "M1 GARAND", dedupeKey: "k3" },
      { serverId: s.id, ts: "2026-08-01T10:08:00.000Z", kind: "evt.kill", actorPlayerId: twinB.id, actorName: "Nemesis", victimPlayerId: twinA.id, victimName: "Nemesis", weapon: "MG42", dedupeKey: "k4" },
    ]);

    const rep = (await anon(`${repoBase}/api/public/alpha/report/${match.seq}`)).body.report;
    assert.equal(rep.players["Nemesis"], undefined, "neither twin is published under the shared name");
    assert.deepEqual(rep.sharedNames, ["Nemesis"], "the wire owns up to the collision by name");
    assert.equal(rep.players["Smith"]?.timeline.length, 2, "the rest of the round is unaffected");
    const raw = JSON.stringify(rep);
    assert.ok(!raw.includes(twinA.id) && !raw.includes(twinB.id), "and still no internal id crosses");
  });
});

/*
 * The server stats profile — /api/public/<slug>/stats. Aggregated purely from the matches table
 * and record reads: wins by side, quality buckets by score gap, per-map rollups, single-round
 * records with the round's public alias — and never any id, internal or platform.
 */
test("the server stats profile aggregates rounds and records without leaking ids", async () => {
  await withServer(async (base, repo) => {
    const { s, smith, jones } = await publishedRound(repo, false);
    // A second finished round: axis take Foy 3-2 (contested), 40 minutes, Jones on 7 kills.
    const m2 = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: "2026-08-02T10:00:00.000Z" });
    await repo.matches.bumpStat({ matchId: m2.id, playerId: jones.id, serverId: s.id, playerName: "Jones", side: "axis", kills: 7 });
    await repo.matches.close(m2.id, { endedAt: "2026-08-02T10:40:00.000Z", winner: "axis", alliedScore: 2, axisScore: 3, result: null });
    // And an open one, which counts as a match but never as a result or a record.
    await repo.matches.open({ serverId: s.id, map: "kursk_warfare", startedAt: "2026-08-03T10:00:00.000Z" });

    const r = await anon(`${base}/api/public/alpha/stats`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = r.body.stats;
    assert.equal(st.overview.matches, 3);
    assert.equal(st.overview.alliesWins, 1);
    assert.equal(st.overview.axisWins, 1);
    assert.equal(st.overview.avgMinutes, 50, "the mean of a 60- and a 40-minute round");
    assert.equal(st.quality.scored, 2);
    assert.equal(st.quality.stomp, 1, "5-0 is a stomp");
    assert.equal(st.quality.contested, 1, "3-2 is contested");
    const foy = (st.maps as { id: string; played: number; axisWins: number }[]).find((m) => m.id === "foy_warfare");
    assert.equal(foy?.played, 1);
    assert.equal(foy?.axisWins, 1);
    assert.equal(st.activity.length, 28, "a month of days, zero-filled — an empty day is a fact");
    assert.equal(st.records.kills[0]?.name, "Jones");
    assert.equal(st.records.kills[0]?.value, 7);
    assert.equal(st.records.kills[0]?.seq, m2.seq, "a record links to its round by the public alias");
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes(smith.id) && !raw.includes(jones.id), "names only — no internal id on this wire");
    assert.equal((await anon(`${base}/api/public/nope/stats`)).status, 404);
  });
});

/*
 * The seeding block of the server profile: seeded share and hour histogram from participant
 * counts, seeding heroes from who plays the low-pop rounds, killer maps from what loaded after a
 * seeded round and emptied the server. Everything counts only rounds WITH participant data —
 * imported history without scoreboards measures nothing.
 */
test("seeding health: seeded share, heroes and server-killer maps from participant counts", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Beta", host: "10.0.0.9", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    await repo.servers.setPublicProfile(s.id, { publicSlug: "beta", publicName: null, publicPlayerIds: false });
    const many = await repo.players.upsertMany(Array.from({ length: 61 }, (_, i) => ({
      game: "hll", platform: "steam", platformId: `7656119800077${String(100 + i)}`, name: `P${i}`,
    })));
    const seeders = await repo.players.upsertMany(["S1", "S2", "S3"].map((n, i) => ({
      game: "hll", platform: "steam", platformId: `765611980009900${i}`, name: n,
    })));
    const round = async (map: string, hour: number, roster: typeof many) => {
      const m = await repo.matches.open({ serverId: s.id, map, startedAt: `2026-08-10T${String(hour).padStart(2, "0")}:00:00.000Z` });
      await repo.matches.bumpStatMany(roster.map((p) => ({ matchId: m.id, playerId: p!.id, serverId: s.id, playerName: p!.name, kills: 1 })));
      await repo.matches.close(m.id, { endedAt: `2026-08-10T${String(hour).padStart(2, "0")}:50:00.000Z`, winner: "allies", alliedScore: 5, axisScore: 0, result: null });
      return m;
    };
    await round("carentan_warfare", 10, many);  // seeded (61 players)
    await round("kursk_warfare", 12, seeders);  // the server died on it (3 players)
    await round("foy_warfare", 14, many);       // seeded again
    await round("kursk_warfare", 16, seeders);  // and died on Kursk again

    const r = await anon(`${base}/api/public/beta/stats`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sd = r.body.stats.seeding;
    assert.ok(sd, "participant data exists, so the seeding card has numbers");
    assert.equal(sd.measuredRounds, 4);
    assert.equal(sd.seededShare, 50, "two of four measured rounds hit 60+ players");
    assert.equal(sd.hoursUtc[10] + sd.hoursUtc[14], 2, "seeded starts land in their UTC hours");
    assert.equal(sd.heroes[0].rounds, 2, "the regular low-pop grinders top the heroes board");
    assert.equal(sd.killers.length, 1);
    assert.deepEqual({ drops: sd.killers[0].drops, after: sd.killers[0].after }, { drops: 2, after: 2 });
    assert.ok(/kursk/i.test(sd.killers[0].map), "the map that keeps emptying the server is named");
  });
});

/*
 * The weapon-class boards on the server profile: fed by the worker's rollups, labelled by the
 * game's own classifier catalogue, best-single-round and career-total per class, "other" never
 * drawn. Rollups are written directly here — the worker's fold has its own unit test.
 */
test("server stats: weapon-class boards read the rollups, labelled by the game's classifier", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Gamma", host: "10.0.0.10", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    await repo.servers.setPublicProfile(s.id, { publicSlug: "gamma", publicName: null, publicPlayerIds: false });
    const ada = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000888001", name: "Ada" });
    const bea = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000888002", name: "Bea" });
    const m1 = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-08-05T10:00:00.000Z" });
    await repo.matches.close(m1.id, { endedAt: "2026-08-05T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: null });
    const m2 = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: "2026-08-05T12:00:00.000Z" });
    await repo.matches.close(m2.id, { endedAt: "2026-08-05T13:00:00.000Z", winner: "axis", alliedScore: 0, axisScore: 5, result: null });
    await repo.matches.saveWeaponRollup(m1.id, [
      { playerId: ada.id, weapon: "MG42", classId: "mg", kills: 40, deaths: 0 },
      { playerId: ada.id, weapon: "DP-27", classId: "mg", kills: 2, deaths: 0 },
      { playerId: bea.id, weapon: "155MM HOWITZER [M114]", classId: "artillery", kills: 88, deaths: 0 },
      { playerId: ada.id, weapon: "155MM HOWITZER [M114]", classId: "artillery", kills: 0, deaths: 30 },
      { playerId: ada.id, weapon: "SATCHEL", classId: "other", kills: 3, deaths: 0 },
    ]);
    await repo.matches.saveWeaponRollup(m2.id, [
      { playerId: ada.id, weapon: "MG42", classId: "mg", kills: 10, deaths: 0 },
      { playerId: ada.id, weapon: "155MM HOWITZER [M114]", classId: "artillery", kills: 0, deaths: 12 },
    ]);

    const r = await anon(`${base}/api/public/gamma/stats`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const boards = r.body.stats.classRecords as { classId: string; label: string; best: { name: string; value: number; seq: number; weapon?: string }[]; career: { name: string; kills: number }[]; deaths: { name: string; deaths: number }[] }[];
    assert.deepEqual(boards.map((b) => b.classId), ["artillery", "mg"], "ordered by the biggest single round, 'other' never drawn");
    assert.equal(boards[0]!.label, "Artillery", "labelled by the game's classifier catalogue");
    assert.equal(boards[0]!.best[0]?.name, "Bea");
    assert.equal(boards[0]!.best[0]?.value, 88);
    assert.equal(boards[0]!.best[0]?.seq, m1.seq, "a class record links to its round");
    const mg = boards[1]!;
    assert.equal(mg.best[0]?.value, 42, "a class record sums the round's weapons in that class");
    assert.equal(mg.best[0]?.weapon, "MG42", "and names the weapon that carried it");
    assert.deepEqual(mg.career[0], { name: "Ada", kills: 52 }, "career totals sum across rounds");

    // The individual-weapon boards ride the same wire.
    const weapons = r.body.stats.weaponRecords as { weapon: string; totalKills: number; best: { name: string; value: number }[]; career: { name: string; kills: number }[]; deaths: { name: string; deaths: number }[] }[];
    assert.deepEqual(weapons.map((w) => w.weapon), ["155MM HOWITZER [M114]", "MG42", "SATCHEL", "DP-27"], "most-used weapons first");
    const mg42 = weapons.find((w) => w.weapon === "MG42")!;
    assert.equal(mg42.totalKills, 50);
    assert.deepEqual(mg42.best[0], { ...mg42.best[0], name: "Ada", value: 40 }, "best single round with that weapon");
    assert.deepEqual(mg42.career[0], { name: "Ada", kills: 50 });

    // The victim side: died-to leaders per class and per weapon, summed across rounds.
    assert.deepEqual(boards[0]!.deaths[0], { name: "Ada", deaths: 42 }, "who dies to artillery the most, career");
    const howitzer = weapons.find((w) => w.weapon === "155MM HOWITZER [M114]")!;
    assert.deepEqual(howitzer.deaths[0], { name: "Ada", deaths: 42 });
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes(ada.id) && !raw.includes(bea.id), "names only, as everywhere on this wire");
  });
});

/*
 * The public career page — /api/public/<slug>/player/<platform_id>. The privacy contract under
 * test: it answers ONLY on servers publishing platform ids, only for players who actually played
 * that server, echoes the platform id alone, and a foreign or unknown player is the same 404.
 */
test("public career: platform-id addressed, gated on the ids toggle, never a directory probe", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith } = await publishedRound(repo, true);
    await repo.stats.bump(smith.id, s.id, { kills: 217, deaths: 100, playtimeSec: 7200, visits: 5 });
    await repo.matches.saveWeaponRollup(match.id, [
      { playerId: smith.id, weapon: "M1 GARAND", classId: "rifle", kills: 2, deaths: 0 },
      { playerId: smith.id, weapon: "MG42", classId: "mg", kills: 0, deaths: 6 },
    ]);

    const r = await anon(`${base}/api/public/alpha/player/76561198000000001`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.player.name, "Smith");
    assert.equal(r.body.player.platformId, "76561198000000001");
    assert.equal(r.body.career.kills, 217);
    assert.equal(r.body.career.playtimeSec, 7200);
    assert.equal(r.body.rounds.length, 1);
    assert.equal(r.body.rounds[0].seq, match.seq, "each round links by the public alias");
    assert.equal(r.body.rounds[0].kills, 2);
    assert.equal(r.body.rounds[0].won, true, "allies line on an allied win");
    assert.deepEqual(r.body.weapons, [{ weapon: "M1 GARAND", kills: 2 }], "career weapons ride the page");
    assert.deepEqual(r.body.deathsTo, [{ weapon: "MG42", deaths: 6 }], "and so does what keeps killing them");
    assert.ok(!JSON.stringify(r.body).includes(smith.id), "the internal id never crosses");

    // A player in the directory who never played THIS server answers exactly like a missing one.
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000009", name: "Stranger" });
    assert.equal((await anon(`${base}/api/public/alpha/player/76561198000000009`)).status, 404);
    assert.equal((await anon(`${base}/api/public/alpha/player/nope`)).status, 404);
  });
});

test("public career: a server that withholds platform ids has no career pages at all", async () => {
  await withServer(async (base, repo) => {
    await publishedRound(repo, false);
    assert.equal((await anon(`${base}/api/public/alpha/player/76561198000000001`)).status, 404,
      "ids off means no public address for a person — uniform 404, not a hint");
  });
});

/*
 * The round report is the heaviest fold on the public surface (stat rows + up to 20k kill
 * events), and a shared link means anonymous strangers re-running it. It is served from a
 * per-round cache now: within the TTL the fold does not re-run — proven by inserting a kill
 * between two reads and getting the same report twice — and the whistle refolds immediately,
 * because a finished round must not spend a minute serving its last live fold.
 */
test("the round report folds once per TTL, and the whistle refolds it at once", async () => {
  await withServer(async (base, repo) => {
    const { s, match, smith, jones } = await publishedRound(repo);
    const first = await anon(`${base}/api/public/alpha/report/${match.seq}`);
    assert.equal(first.status, 200);

    // A kill landing after the first read is invisible within the TTL — the cache is serving.
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-01T10:07:00.000Z", kind: "evt.kill", actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: jones.id, victimName: "Jones", weapon: "M1 GARAND", dedupeKey: "k3" },
    ]);
    const second = await anon(`${base}/api/public/alpha/report/${match.seq}`);
    assert.deepEqual(second.body.report, first.body.report, "within the TTL the fold is not re-run");

    // A LIVE round caches on the short live TTL, and closing it refolds despite the cache.
    const live = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: "2026-08-02T10:00:00.000Z" });
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-02T10:01:00.000Z", kind: "evt.kill", actorName: "Ana", victimName: "Bob", weapon: "M1 GARAND", dedupeKey: "l1" },
    ]);
    const liveFirst = await anon(`${base}/api/public/alpha/report/current`);
    assert.equal(liveFirst.status, 200);
    await repo.events.insert([
      { serverId: s.id, ts: "2026-08-02T10:02:00.000Z", kind: "evt.kill", actorName: "Ana", victimName: "Bob", weapon: "M1 GARAND", dedupeKey: "l2" },
    ]);
    const liveSecond = await anon(`${base}/api/public/alpha/report/current`);
    assert.deepEqual(liveSecond.body.report, liveFirst.body.report, "the live poll shares one fold per interval");

    await repo.matches.close(live.id, { endedAt: "2026-08-02T10:30:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    const after = await anon(`${base}/api/public/alpha/report/${live.seq}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.report.complete, true, "folded as a finished round");
    assert.notDeepEqual(after.body.report, liveFirst.body.report,
      "the whistle refolds at once — the cached live fold (missing the second kill) is not served");
  });
});

/*
 * The staff alias ON the public page. Everywhere else in the app `name` now IS the nickname —
 * the repository resolves it at the read boundary — but the stats page is the one deliberate
 * exception: players found this server by its browser name, so the page keeps the public
 * identity and wears the alias QUOTED beside it instead of replacing it.
 */
test("the manifest keeps the public identity and quotes the staff alias beside it", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "The Long Browser Name", host: "10.0.0.31", port: 28931, password: "p" });
    await repo.servers.setStreamerMode(s.id, true);
    await repo.servers.setPublicProfile(s.id, { publicSlug: "main", publicName: null, publicPlayerIds: true });
    await repo.servers.setNickname(s.id, "WW2 Main");

    const r = await anon(`${base}/api/public/servers`);
    const row = (r.body.servers as { slug: string; name: string }[]).find((x) => x.slug === "main");
    assert.equal(row?.name, "The Long Browser Name “WW2 Main”", "game identity first, the alias quoted");

    // An explicit public name still owns the identity half; the alias still rides quoted.
    await repo.servers.setPublicProfile(s.id, { publicSlug: "main", publicName: "LYNX WW2", publicPlayerIds: true });
    const r2 = await anon(`${base}/api/public/servers`);
    assert.equal((r2.body.servers as { slug: string; name: string }[]).find((x) => x.slug === "main")?.name, "LYNX WW2 “WW2 Main”");

    // And without a nickname there are no stray quotes.
    await repo.servers.setNickname(s.id, null);
    const r3 = await anon(`${base}/api/public/servers`);
    assert.equal((r3.body.servers as { slug: string; name: string }[]).find((x) => x.slug === "main")?.name, "LYNX WW2");
  });
});

/*
 * The coordinate leak-guard — written the week a CRCON exploit made live player positions
 * publicly readable, and communities found out from their access logs. Our anonymous surface is
 * safe TODAY because every payload is a fixed field-by-field projection; this test is what keeps
 * that true TOMORROW. It walks every anonymous endpoint's entire JSON and fails on any
 * position-shaped key: the exact wire names both protocols use, anything calling itself
 * coordinates, and any {x,y,z} numeric triplet — so passing a raw roster row through a
 * "harmless" new field cannot ship.
 */
function positionShapedKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => positionShapedKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const bad: string[] = [];
  for (const k of Object.keys(obj)) {
    if (/^(worldposition|world_position|coords?|coordinates|player_positions?)$/i.test(k)) bad.push(`${path}.${k}`);
    bad.push(...positionShapedKeys(obj[k], `${path}.${k}`));
  }
  if (["x", "y", "z"].every((k) => typeof obj[k] === "number")) bad.push(`${path}.{x,y,z}`);
  return bad;
}

test("no anonymous endpoint carries a position-shaped field, anywhere in its payload", async () => {
  const { FakeHllServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    try {
      // The game REPORTS a position for everyone on the live roster; the projections must drop it.
      fake.players = [{ iD: "76561198000000001", name: "Smith", worldPosition: { x: 123.4, y: -56.7, z: 8.9 } }];
      const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
      await repo.servers.setStreamerMode(s.id, true);
      await repo.servers.setPublicProfile(s.id, { publicSlug: "alpha", publicName: null, publicPlayerIds: true });
      const smith = (await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Smith", ts: "2026-08-01T09:00:00.000Z" }]))[0]!;
      const match = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-08-01T10:00:00.000Z" });
      await repo.matches.bumpStat({ matchId: match.id, playerId: smith.id, serverId: s.id, playerName: "Smith", side: "allies", kills: 4 });
      await repo.events.insert([
        { serverId: s.id, ts: "2026-08-01T10:05:00.000Z", kind: "evt.kill", actorPlayerId: smith.id, actorName: "Smith", victimPlayerId: null, victimName: "Jones", weapon: "M1 GARAND", dedupeKey: "pg1" },
      ]);
      await repo.matches.close(match.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: null });

      // Guard the guard: a walker that stops flagging a planted leak turns this test into decoration.
      assert.deepEqual(positionShapedKeys({ a: [{ worldPosition: { x: 1, y: 2, z: 3 } }] }, "probe"),
        ["probe.a[0].worldPosition", "probe.a[0].worldPosition.{x,y,z}"]);

      const answers: [string, unknown][] = [];
      const commands = [
        "get_version", "get_public_info", "get_live_scoreboard", "get_live_game_stats",
        "get_scoreboard_maps", `get_map_scoreboard?map_id=${match.seq}`, "get_map_history", "get_previous_map",
      ];
      for (const c of commands) answers.push([c, (await anon(`${base}/stats/alpha/api/${c}`)).body]);
      answers.push(["manifest", (await anon(`${base}/api/public/servers`)).body]);
      answers.push(["report", (await anon(`${base}/api/public/alpha/report/${match.seq}`)).body]);
      answers.push(["stats", (await anon(`${base}/api/public/alpha/stats`)).body]);
      answers.push(["player", (await anon(`${base}/api/public/alpha/player/76561198000000001`)).body]);

      // The guard must be scanning a payload that really carried the rostered player — the row
      // whose LIVE read the fake answered with a worldPosition on it.
      const scoreboard = answers.find(([n]) => n === "get_live_scoreboard")![1] as { result?: { stats?: unknown[] } };
      assert.ok((scoreboard.result?.stats?.length ?? 0) > 0, "the scoreboard answered with player rows to scan");

      const leaks = answers.flatMap(([name, body]) => positionShapedKeys(body, name));
      assert.deepEqual(leaks, [], `position-shaped fields on the anonymous surface:\n  ${leaks.join("\n  ")}`);
    } finally {
      fake.close();
    }
  });
});
