/**
 * Streamer mode — the CRCON-compatible surface that answers WITHOUT a login.
 *
 * These tests exist mostly to pin the security boundary rather than the JSON: this is the only
 * unauthenticated part of the app, so "off means invisible" and "only the whitelist is reachable"
 * are the properties that must never regress. The shape assertions cover the parity claim — a
 * streamer's existing tool reads `failed` and then `result`, so both have to be exactly where
 * CRCON puts them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// The app comes from the BUILT output like every other api test — it imports .js paths that
// only exist after tsc. The pure builders come straight from source, so a shape assertion fails
// against the code as written rather than against a stale build.
import { FakeHllServer } from "./fake-hll-server.ts";
import { buildVoteStatus, foldKillWindow } from "../dist/streamer.js";
// The same module instance the builders use: PyFloat is recognised by class.
import { pyDumps } from "../dist/crcon-json.js";
import { PublicRateLimiter, ATTACKER_SIDE, buildLayer, buildMapHistory, buildPreviousMap, buildPublicInfo, crconLayer, envelope, ENDPOINTS, IMPLEMENTED, mapHistoryEntries, type MapHistoryRound } from "../dist/streamer.js";
import { withServer } from "./harness.ts";

/** Deliberately sends NO authorization header — that is the whole point of the surface. */
async function anon(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** Django 4.2's stock error pages (django/views/defaults.py), byte for byte: what CRCON's API
 *  answers where a view raises, or where Django refuses the request before a view can answer. */
const DJANGO_500 = '\n<!doctype html>\n<html lang="en">\n<head>\n  <title>Server Error (500)</title>\n</head>\n<body>\n  <h1>Server Error (500)</h1><p></p>\n</body>\n</html>\n';
const DJANGO_400 = '\n<!doctype html>\n<html lang="en">\n<head>\n  <title>Bad Request (400)</title>\n</head>\n<body>\n  <h1>Bad Request (400)</h1><p></p>\n</body>\n</html>\n';

test("streamer mode off: the server is invisible, not merely forbidden", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    assert.equal(s.streamerMode, false, "a new server does not publish anything");

    const r = await anon(`${base}/s/${s.id}/api/get_version`);
    assert.equal(r.status, 404);
    assert.equal(r.body.failed, true);
    // A 403 saying "enable streamer mode" would confirm the id names a real server. An anonymous
    // caller must not be able to tell a disabled server from one that does not exist.
    assert.equal(r.body.error, "not found");
    const missing = await anon(`${base}/s/00000000-0000-0000-0000-000000000000/api/get_version`);
    assert.deepEqual(
      { status: missing.status, error: missing.body.error },
      { status: r.status, error: r.body.error },
      "a disabled server and a nonexistent one answer identically",
    );
  });
});

test("streamer mode on: CRCON's envelope, no credentials needed", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);

    const r = await anon(`${base}/s/${s.id}/api/get_version`);
    assert.equal(r.status, 200);
    // Every key CRCON sends, present. A tool that destructures the envelope must not hit undefined.
    assert.deepEqual(Object.keys(r.body).sort(), ["arguments", "command", "error", "failed", "forwards_results", "result", "version"]);
    assert.equal(r.body.command, "get_version", "the envelope echoes the command that was called");
    assert.equal(r.body.failed, false);
    assert.equal(r.body.forwards_results, null, "read-only surface: nothing is ever forwarded");
    assert.ok(typeof r.body.result === "string" && r.body.result.length > 0);
  });
});

/*
 * The whitelist IS the security boundary.
 *
 * CRCON has 304 endpoints and 296 of them require a login. If reachability were decided by "does
 * this app have a handler for that name" rather than by an explicit list, every future route would
 * be one naming coincidence away from being public.
 */
test("only the eight public CRCON names are reachable; nothing else exists", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);

    // run_raw_command is the one that matters: it looks unauthenticated in CRCON's source (no
    // login_required) but is permission_required, and it executes arbitrary RCON.
    for (const forbidden of ["run_raw_command", "get_players", "get_detailed_players", "message_player", "get_vip_ids", "get_audit_logs", "login"]) {
      const r = await anon(`${base}/s/${s.id}/api/${forbidden}`);
      assert.equal(r.status, 404, `${forbidden} must not be reachable`);
      assert.equal(r.body.failed, true);
      assert.equal(r.body.error, "unknown command");
    }

    assert.deepEqual(
      Object.keys(ENDPOINTS).sort(),
      ["get_live_game_stats", "get_live_scoreboard", "get_map_history", "get_map_scoreboard", "get_previous_map", "get_public_info", "get_scoreboard_maps", "get_version"],
      "the whitelist is exactly CRCON's public set — see docs/streamer-mode.md",
    );
    for (const name of IMPLEMENTED) assert.ok(ENDPOINTS[name], `${name} is implemented but not budgeted`);
  });
});

test("map history and previous map are CRCON's, byte for byte", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    // A round from before the worker filed rounds: its log text is guessed from, guessed is true,
    // and as a past entry its timeline is cleared, as CRCON's stats job clears it.
    const first = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    await repo.matches.recordTimeline(first.id, { flip: [30, 2, 2] });
    await repo.matches.close(first.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: "`CARENTAN Warfare` ALLIED (5 - 0) AXIS" });
    // The round in progress, filed by the worker as it started, with a layout staff set.
    const live = await repo.matches.open({ serverId: s.id, map: "SAINTE-MÈRE-ÉGLISE Warfare", startedAt: "2026-08-01T11:05:00.000Z" });
    await repo.matches.recordStart(live.id, { map: "stmereeglise_warfare_night", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.recordTimeline(live.id, { flip: [30, 2, 2] });
    await repo.matches.recordTimeline(live.id, { flip: [400, 3, 2] });
    await repo.matches.recordSectorLayout({ serverId: s.id, layout: ["A", "B", "C", "D", "E"], by: "staff" });
    const tail = ',"command":"get_map_history","arguments":{},"failed":false,"error":null,"forwards_results":null,"version":"v12.3.0"}';

    const hist = await fetch(`${base}/s/${s.id}/api/get_map_history`);
    assert.equal(hist.status, 200);
    assert.equal(await hist.text(), '{"result":['
      + '{"name":"stmereeglise_warfare_night","start":1785582300,"end":null,"guessed":false,"game_layout":{"requested":["A","B","C","D","E"],"set":["A","B","C","D","E"]},'
      + '"cap_flips":[{"allied_score":2,"axis_score":2,"ts":30},{"allied_score":3,"axis_score":2,"ts":400}],"morale_history":[],"initial_morale":0,"match_time":5400},'
      + '{"name":"carentan_warfare","start":1785578400,"end":1785582000,"guessed":true,"game_layout":{"requested":[],"set":[]},'
      + '"cap_flips":[],"morale_history":[],"initial_morale":null,"match_time":0}'
      + "]" + tail);

    // `?pretty`: name, start and end only, in Python's isoformat spelling ("+00:00", no fraction).
    const pretty = await fetch(`${base}/s/${s.id}/api/get_map_history?pretty=1`);
    assert.equal(await pretty.text(), '{"result":['
      + '{"name":"stmereeglise_warfare_night","start":"2026-08-01T11:05:00+00:00","end":null},'
      + '{"name":"carentan_warfare","start":"2026-08-01T10:00:00+00:00","end":"2026-08-01T11:00:00+00:00"}'
      + "]" + tail);
    // An empty `pretty=` is Python's empty string: falsy, so the whole entries.
    const blank = await anon(`${base}/s/${s.id}/api/get_map_history?pretty=`);
    assert.equal(blank.body.result[0].guessed, false);

    // Index 1 of the history — the round before the one in progress.
    const prev = await fetch(`${base}/s/${s.id}/api/get_previous_map`);
    assert.equal(await prev.text(), '{"result":{"name":"carentan_warfare","start":"2026-08-01T10:00:00+00:00","end":"2026-08-01T11:00:00+00:00"},'
      + '"command":"get_previous_map","arguments":null,"failed":false,"error":null,"forwards_results":null,"version":"v12.3.0"}');
  });
});

test("map history lists the short rounds our records drop, as CRCON lists every round it saw start", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    const long = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    await repo.matches.close(long.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: null, alliedScore: 2, axisScore: 2, result: null });
    const short = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: "2026-08-01T11:01:00.000Z" });
    await repo.matches.discardShort(short.id, "2026-08-01T11:02:00.000Z", "`KURSK Warfare` ALLIED (2 - 2) AXIS");
    await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T11:03:00.000Z" });

    const hist = await anon(`${base}/s/${s.id}/api/get_map_history`);
    assert.deepEqual(hist.body.result.map((e: { name: string; end: number | null }) => [e.name, e.end]), [
      ["carentan_warfare", null], ["kursk_warfare", Date.parse("2026-08-01T11:02:00.000Z") / 1000], ["foy_warfare", Date.parse("2026-08-01T11:00:00.000Z") / 1000],
    ]);
    const prev = await anon(`${base}/s/${s.id}/api/get_previous_map`);
    assert.equal(prev.body.result.name, "kursk_warfare", "the round before the one in progress, however short");
  });
});

const historyRound = (over: Partial<MapHistoryRound> = {}): MapHistoryRound => ({
  map: "carentan_warfare", startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T11:00:00.000Z",
  sectorLayout: null, capFlips: [[30, 2, 2]], moraleHistory: [[30, 500, 490]], matchTime: 5400, ...over,
});

test("no previous map is a fact, not a failure", () => {
  // CRCON catches the IndexError and answers result:null with failed:false. A tool that treated
  // "first round after a restart" as an error would show a broken overlay for a whole match.
  assert.equal(buildPreviousMap([]), null);
  assert.equal(buildPreviousMap(mapHistoryEntries([historyRound({ endedAt: null })], "hll")), null);
});

test("a deferred end is the next round's start, and only the newest entry keeps its timeline", () => {
  const rounds = [
    historyRound({ startedAt: "2026-08-01T12:00:00.000Z", endedAt: null, crconMap: "foy_warfare", crconGuessed: false }),
    historyRound({ crconEndDeferred: true }),
    historyRound({ startedAt: "2026-08-01T08:00:00.000Z", endedAt: "2026-08-01T09:00:00.000Z", crconEndDeferred: false }),
  ];
  const e = mapHistoryEntries(rounds, "hll");
  assert.deepEqual(e.map((x) => x.end), [null, 1785585600, Date.parse("2026-08-01T09:00:00.000Z") / 1000], "a deferred end waits for the next MATCH START");
  assert.deepEqual(e.map((x) => x.capFlips), [[[30, 2, 2]], [], []]);
  assert.deepEqual(e.map((x) => x.moraleHistory), [[[30, 500, 490]], [], []]);
  assert.deepEqual(e.map((x) => [x.name, x.guessed, x.matchTime]), [["foy_warfare", false, 5400], ["carentan_warfare", true, 5400], ["carentan_warfare", true, 5400]]);
  assert.equal(mapHistoryEntries([rounds[1]!], "hll")[0]!.end, null, "and is null while no round has started after it");
});

/*
 * get_public_info as CRCON v12.3.0's view writes it (rconweb/api/views.py), checked as bytes:
 * its key order, the newest round's start and recorded timeline, time_remaining as a float, the
 * game's config untouched plus `game`, and the vote status CRCON gives when its vote is off.
 */
test("public info is CRCON's get_public_info, byte for byte", () => {
  const info = buildPublicInfo({
    game: "hll", serverName: "The Division #1", shortName: "Div", currentMapId: "carentan_warfare", nextMapId: "unknown",
    latest: { start: 1754000000, capFlips: [[30, 2, 2], [400, 3, 2]], moraleHistory: [], matchTime: 5400 },
    playerCount: 82, maxPlayerCount: 100, alliedPlayers: 41, axisPlayers: 41, alliedScore: 3, axisScore: 2,
    alliedMorale: 0, axisMorale: 0, initialMorale: 0, timeRemainingSec: 1800,
    voteStatus: buildVoteStatus({ enabled: false, paused: false, options: [], tallies: [], overrideMapId: null, game: "hll" }),
    serverConfig: { serverName: "The Division #1", buildNumber: "12345", buildRevision: "abc", supportedPlatforms: ["Steam", "WinGDK", "eos"], passwordProtected: false },
  });
  assert.equal(pyDumps(info), '{"current_map":{"map":{"id":"carentan_warfare","map":{"id":"carentan","name":"CARENTAN","tag":"CAR","pretty_name":"Carentan","shortname":"Carentan","allies":{"name":"us","team":"allies"},"axis":{"name":"ger","team":"axis"},"orientation":"horizontal"},"game_mode":"warfare","attackers":null,"environment":"day","pretty_name":"Carentan Warfare","image_name":"carentan-day.webp"},"start":1754000000},"next_map":{"map":{"id":"unknown","map":{"id":"unknown","name":"unknown","tag":"","pretty_name":"unknown","shortname":"unknown","allies":{"name":"us","team":"allies"},"axis":{"name":"ger","team":"axis"},"orientation":"vertical"},"game_mode":"warfare","attackers":null,"environment":"day","pretty_name":"unknown Warfare","image_name":"unknown-day.webp"},"start":null},"player_count":82,"max_player_count":100,"player_count_by_team":{"allied":41,"axis":41},"score":{"allied":3,"axis":2},"allied_morale":0,"axis_morale":0,"initial_morale":0,"morale_history":[],"cap_flips":[{"allied_score":2,"axis_score":2,"ts":30},{"allied_score":3,"axis_score":2,"ts":400}],"match_time":5400,"time_remaining":1800.0,"vote_status":{"enabled":false,"paused":false,"results":[],"last_reminder":null,"next_map":null,"player_choice":null},"name":{"name":"The Division #1","short_name":"Div","public_stats_port":null,"public_stats_port_https":null},"config":{"build_number":"12345","build_revision":"abc","password_protected":false,"server_name":"The Division #1","supported_platforms":["Steam","WinGDK","eos"],"game":"hll"}}');

  // No round on record: CRCON's map history is empty, so no start, no timeline (cap_flips null).
  const bare = buildPublicInfo({
    game: "hll", serverName: "X", shortName: "", currentMapId: "", nextMapId: "", latest: null,
    playerCount: 0, maxPlayerCount: 100, alliedPlayers: 0, axisPlayers: 0, alliedScore: 2, axisScore: 2,
    alliedMorale: 0, axisMorale: 0, initialMorale: 0, timeRemainingSec: 0, voteStatus: null, serverConfig: null,
  }) as Record<string, any>;
  assert.equal(bare.current_map.start, null);
  assert.equal(bare.current_map.map.id, "unknown", "an empty layer id is CRCON's unknown layer, never null");
  assert.equal(bare.cap_flips, null);
  assert.deepEqual(bare.morale_history, []);
  assert.equal(bare.match_time, 0);
  assert.equal(pyDumps(bare.time_remaining), "0.0");
});

test("the rate limiter mirrors CRCON's per-IP budget", () => {
  let now = 1_000_000;
  const rl = new PublicRateLimiter(() => now);
  for (let i = 0; i < 10; i++) assert.equal(rl.allow("get_version", "1.2.3.4", 10), true, `call ${i + 1} of 10 is inside the budget`);
  assert.equal(rl.allow("get_version", "1.2.3.4", 10), false, "the 11th in a minute is refused");
  // Budgets are per endpoint and per address, exactly as CRCON keys them.
  assert.equal(rl.allow("get_public_info", "1.2.3.4", 60), true, "a different endpoint has its own budget");
  assert.equal(rl.allow("get_version", "5.6.7.8", 10), true, "a different caller has its own budget");
  now += 61_000;
  assert.equal(rl.allow("get_version", "1.2.3.4", 10), true, "the window slides");
});

test("the envelope is filled even when the call fails", () => {
  const e = envelope({ command: "get_public_info", failed: true, error: "boom", version: "v1" });
  assert.equal(e.result, null);
  assert.equal(e.failed, true);
  assert.equal(e.error, "boom");
  assert.equal(e.command, "get_public_info");
  assert.equal(e.forwards_results, null);
});

test("map history formats both of CRCON's forms from one list", () => {
  const [entry] = mapHistoryEntries([historyRound({ startedAt: "2025-07-31T22:13:20.000Z", endedAt: null })], "hll");
  assert.deepEqual(Object.keys(buildMapHistory([entry!], false)[0] as object), ["name", "start", "end", "guessed", "game_layout", "cap_flips", "morale_history", "initial_morale", "match_time"], "MapInfo's keys in save_new_map's order, player_stats left out");
  const pretty = buildMapHistory([entry!], true) as { start: string; end: null }[];
  assert.deepEqual(Object.keys(pretty[0]!), ["name", "start", "end"]);
  assert.equal(pretty[0]!.start, "2025-07-31T22:13:20+00:00", "datetime.fromtimestamp(ts, tz=UTC).isoformat()");
  assert.equal(pretty[0]!.end, null, "a round still running has no end in either form");
});

/*
 * HLL: Vietnam.
 *
 * CRCON's Vietnam support is young and its map catalogue is still filling in, so parts of a
 * Vietnam layer are a best guess at where CRCON lands. Two things are NOT guesses, and they are
 * the two that matter — both read out of CRCON's own source:
 *
 *   - Vietnam keeps the allies/axis vocabulary. `Team.from_hllrcon` folds the game's stable side
 *     ids (1, 2) to allies/axis for BOTH games rather than minting south/north, so a tool gets one
 *     answer set whichever game it points at.
 *   - `nva` is axis and `us`/`usa` are allies (`parse_map_string_attacker`), and `FactionName`
 *     already carries NVA.
 *
 * What IS a guess is the catalogue detail — tags, shortnames, orientations — and that is emitted
 * blank for both games rather than invented.
 */
test("a Vietnam layer names the two armies CRCON has committed to", () => {
  // The shared id grammar carries Vietnam correctly — checked, not assumed: the map inference
  // reads the id's structure rather than a WW2 map list, so no per-game branch is needed here.
  const vietnam = buildLayer("huecity_offensive_nva", "hllv") as any;
  assert.equal(vietnam.map.id, "huecity", "the name comes from the id's own grammar, which both games share");
  assert.equal(vietnam.game_mode, "offensive");
  assert.equal(vietnam.environment, "day", "no environment token means day, as CRCON defaults");

  // Vietnam fields the same two armies every round, so they can be stated — CRCON's own
  // FactionName carries NVA, and its faction→team table puts nva on axis.
  assert.deepEqual(vietnam.map.allies, { name: "us", team: "allies" });
  assert.deepEqual(vietnam.map.axis, { name: "nva", team: "axis" });

  // WW2's faction depends on the map, which is exactly why it comes from CRCON's catalogue rather
  // than a per-game constant. Three maps, three different allied armies — a value no id parse
  // could reach, and the reason this is a table and not a rule.
  const ww2 = buildLayer("carentan_warfare", "hll") as any;
  assert.equal(ww2.map.allies.name, "us");
  assert.equal((buildLayer("kursk_warfare", "hll") as any).map.allies.name, "rus");
  assert.equal((buildLayer("driel_warfare", "hll") as any).map.allies.name, "cw");
  assert.match(ww2.pretty_name, /Carentan/, "and WW2 keeps its display names");

  // The inference has no Vietnam names, so it falls back to the id — but that is not something to
  // fix in code. The map_names store staff already edit from the Maps screen is applied here, so
  // the public API says whatever the panel says.
  assert.equal((buildLayer("huecity_warfare", "hllv") as any).pretty_name, "Huecity — Warfare");
  const named = buildLayer("huecity_warfare", "hllv", new Map([["huecity_warfare", { displayName: "Huế City — Warfare", family: "huecity" }]])) as any;
  assert.equal(named.pretty_name, "Huế City — Warfare", "a staff-set name reaches the public API");
  assert.equal(named.map.pretty_name, "Huế City — Warfare");

  // A row that carries only a family override must not blank the name.
  const familyOnly = buildLayer("huecity_warfare", "hllv", new Map([["huecity_warfare", { displayName: null, family: "hue" }]])) as any;
  assert.equal(familyOnly.pretty_name, "Huecity — Warfare", "a family-only row leaves the name inferred");
  assert.equal(familyOnly.map.id, "hue", "and still applies the family");
});

test("Vietnam offensive layers name the attacking side in CRCON's vocabulary", () => {
  const nvaAttack = buildLayer("huecity_offensive_nva", "hllv") as any;
  assert.equal(nvaAttack.attackers, "axis", "NVA attacks as axis — CRCON's parse_map_string_attacker");
  assert.equal(nvaAttack.game_mode, "offensive");

  const usAttack = buildLayer("huecity_off_us", "hllv") as any;
  assert.equal(usAttack.attackers, "allies", "both `off` and `offensive` spellings parse");

  // A warfare layer has no attacker, in either game.
  assert.equal((buildLayer("huecity_warfare", "hllv") as any).attackers, null);

  // The table matches CRCON's, both games in one vocabulary.
  assert.equal(ATTACKER_SIDE.nva, "axis");
  assert.equal(ATTACKER_SIDE.us, "allies");
  assert.equal(ATTACKER_SIDE.usa, "allies", "CRCON accepts USA as well as US");
  assert.equal(ATTACKER_SIDE.ger, "axis", "WW2 tokens keep working");
  // An unknown token is null, never a coin flip: a new faction must not be assigned a side.
  assert.equal((buildLayer("somewhere_offensive_xyz", "hllv") as any).attackers, null);
});

/*
 * The limiter's key map fails CLOSED at its cap.
 *
 * This is the one surface an anonymous caller can reach, and `clientAddrOf` believes forwarding
 * headers — so a caller not behind the proxy can mint a fresh address per request. The map is
 * capped at 20k keys; the bug this pins is that an unseen key used to be stored anyway when
 * pruning freed nothing, so exactly that spray grew the map without bound. Refusing the unseen
 * key is the login throttle's answer, applied here: 20k distinct addresses in one minute is an
 * attack, not an audience — and a real viewer's key, already in the map, keeps working.
 */
test("rate limiter: at the key cap, unseen addresses are refused, not stored", () => {
  let t = 1_000_000;
  const rl = new PublicRateLimiter(() => t);
  const size = () => (rl as unknown as { hits: Map<string, unknown> }).hits.size;
  // Fill to the cap with live keys (every one has a hit inside the window, so pruning frees none).
  for (let i = 0; i < 20_000; i++) rl.allow("get_version", `10.0.${Math.floor(i / 256)}.${i % 256}`, 10);
  assert.equal(size(), 20_000, "the map is at its cap");

  assert.equal(rl.allow("get_version", "203.0.113.99", 10), false, "a 20,001st address is refused");
  assert.equal(size(), 20_000, "and, decisively, NOT stored");

  // A key already in the map is unaffected — the cap sheds strangers, not the audience.
  assert.equal(rl.allow("get_version", "10.0.0.0", 10), true, "an existing caller still has budget");

  // Once the flood ages out, pruning makes room and new callers are welcome again.
  t += 61_000;
  assert.equal(rl.allow("get_version", "203.0.113.99", 10), true, "after the window, the map admits new keys");
  assert.ok(size() < 20_000, "the aged-out flood was pruned");
});

/*
 * The three fields that used to be stubs.
 *
 * `next_map`, the `config` block and the map catalogue facts were each emitted as CRCON's
 * "recorder is offline" empties because nothing read them. All three are now read from the game
 * itself, so this drives a real fake server and asserts the values arrive — a test that only
 * checked the KEYS existed would have passed against the stubs it replaced.
 */
test("get_public_info: next map, server config and catalogue facts all come from the game", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    fake.rotation = ["carentan_warfare", "stmereeglise_offensive_us", "driel_warfare"];
    fake.session = {
      mapName: "carentan_warfare", playerCount: 42, maxPlayerCount: 100,
      remainingMatchTime: 1800, matchTime: 900,
    };
    const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      const r = await anon(`${base}/s/${s.id}/api/get_public_info`);
      assert.equal(r.body.failed, false, `expected a live read: ${JSON.stringify(r.body.error)}`);
      const info = r.body.result as Record<string, any>;

      // NEXT MAP — the rotation entry after currentIndex 0, taken by its layer ID so the grammar
      // parses. Reading the entry's display `name` instead would give a mode of "" here.
      assert.equal(info.next_map.map.id, "stmereeglise_offensive_us");
      assert.equal(info.next_map.map.game_mode, "offensive");
      assert.equal(info.next_map.map.attackers, "allies", "the _us token is the attacking side");
      assert.equal(info.next_map.start, null, "a map that has not begun has no start, as CRCON says");

      // CONFIG — read from the game, not invented.
      assert.equal(info.config.build_number, "123456");
      assert.equal(info.config.build_revision, "abcdef");
      assert.deepEqual(info.config.supported_platforms, ["Steam", "WinGDK"]);
      assert.equal(info.config.password_protected, false);

      // CATALOGUE FACTS — CRCON's own values for Carentan, which no id can be parsed into.
      const cur = info.current_map.map.map;
      assert.equal(cur.tag, "CAR");
      assert.equal(cur.shortname, "Carentan");
      assert.equal(cur.orientation, "horizontal");
      assert.equal(cur.name, "CARENTAN", "the shouted catalogue name, distinct from pretty_name");
      assert.equal(cur.allies.name, "us");
      assert.equal(cur.axis.name, "ger");
    } finally {
      fake.close();
    }
  });
});

/*
 * Vietnam's maps are CRCON's own catalogue for that game: hllrcon 2.0.0.6's data, which CRCON
 * v12.3.0 loads (rcon/game/hllv/maps.py). An id that catalogue does not know stays on Vietnam's own
 * "unknown" map as a Domination layer, never handed to the WW2 parser, exactly as CRCON keeps it.
 */
test("get_public_info: Vietnam maps are CRCON's Vietnam catalogue, and an unknown id is CRCON's unknown", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    fake.session = { mapId: "wdevc_warfare_day", playerCount: 1, maxPlayerCount: 100 };
    const s = await repo.servers.create({ name: "Nam", host: "127.0.0.1", port, password: "pw", game: "hllv" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      const known = (await anon(`${base}/s/${s.id}/api/get_public_info`)).body.result as Record<string, any>;
      assert.deepEqual(known.current_map.map, {
        id: "wdevc_warfare_day",
        map: { id: "wdevc", name: "HUẾ OUTSKIRTS", tag: "HUE", pretty_name: "Huế Outskirts", shortname: "Huế", allies: { name: "us", team: "allies" }, axis: { name: "nva", team: "axis" }, orientation: "vertical" },
        game_mode: "warfare", attackers: null, environment: "day", pretty_name: "Huế Outskirts Warfare", image_name: "wdevc-day.webp",
      });

      fake.session = { mapId: "huecity_warfare", playerCount: 1, maxPlayerCount: 100 };
      await new Promise((r) => setTimeout(r, 5100)); // past the live read's 5 s cache
      const unknown = (await anon(`${base}/s/${s.id}/api/get_public_info`)).body.result as Record<string, any>;
      assert.deepEqual(unknown.current_map.map, {
        id: "huecity_warfare",
        map: { id: "unknown", name: "unknown", tag: "", pretty_name: "unknown", shortname: "unknown", allies: { name: "unknown", team: "allies" }, axis: { name: "unknown", team: "axis" }, orientation: "vertical" },
        game_mode: "domination", attackers: null, environment: "day", pretty_name: "unknown Domination", image_name: "unknown-day.webp",
      });
    } finally {
      fake.close();
    }
  });
});

test("get_public_info: a v2 server's serverconfig must hold CRCON's fields, or it is CRCON's server error", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    // CRCON's get_server_config reads each field by its name (cfg["buildNumber"] and so on) and its
    // view catches nothing: an answer without one, here a field under another casing, is a KeyError
    // and Django's server error page, never a config made up from defaults.
    fake.serverConfig = { serverName: "Fake Server", BuildNumber: "123456", buildRevision: "abcdef", supportedPlatforms: ["Steam"], passwordProtected: false };
    fake.session = { mapName: "foy_warfare", playerCount: 7, maxPlayerCount: 100 };
    const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      const r = await fetch(`${base}/s/${s.id}/api/get_public_info`);
      assert.deepEqual([r.status, r.headers.get("content-type"), await r.text()], [500, "text/html; charset=utf-8", DJANGO_500]);
    } finally {
      fake.close();
    }
  });
});

/*
 * Lives, from the round's own deaths.
 *
 * These were null on the claim that a life is bounded by a spawn and the kill stream carries none.
 * The first half is true and the conclusion was wrong: HLL's log has no spawn line for CRCON
 * either, so CRCON marks a respawn by the death that caused it — which is why its own
 * PlayerStatsType carries `last_spawn` beside these two. Same source, same derivation.
 */
test("lives are measured death to death, and the unfinished one is not counted", () => {
  const start = "2026-08-20T10:00:00.000Z";
  const at = (sec: number) => new Date(Date.parse(start) + sec * 1000).toISOString();
  // p1 is seen at 0s (a kill), dies at 30s, dies again at 50s, then kills again and survives.
  const fold = foldKillWindow([
    { kind: "evt.kill", ts: at(0), actorPlayerId: "p1", actorName: "One", victimPlayerId: "p2", victimName: "Two", weapon: "M1" },
    { kind: "evt.kill", ts: at(30), actorPlayerId: "p2", actorName: "Two", victimPlayerId: "p1", victimName: "One", weapon: "K98" },
    { kind: "evt.kill", ts: at(50), actorPlayerId: "p2", actorName: "Two", victimPlayerId: "p1", victimName: "One", weapon: "K98" },
    { kind: "evt.kill", ts: at(90), actorPlayerId: "p1", actorName: "One", victimPlayerId: "p2", victimName: "Two", weapon: "M1" },
  ] as any, start);

  const p1 = fold.get("p1")!;
  assert.equal(p1.longestLifeSecs, 30, "0s → first death at 30s");
  assert.equal(p1.shortestLifeSecs, 20, "30s → second death at 50s");
  // The life running at the whistle has no end. Counting it would invent a number, and its length
  // would grow every time the endpoint was polled.
  assert.equal(p1.lastSpawnSecs, 50, "last respawn is the last death");

  // p2's first appearance IS their death at 0s, so their first "life" measures 0 — CRCON's
  // _process_death_time does exactly this, seeding last_spawn to the first appearance and then
  // closing a life on every death including that one. Their second life runs 0s → 90s.
  const p2 = fold.get("p2")!;
  assert.equal(p2.longestLifeSecs, 90, "0s → 90s is the longer of p2's two lives");
  assert.equal(p2.shortestLifeSecs, 0, "the death at 0s closes a life of length 0, and it counts");
  assert.equal(p2.lastSpawnSecs, 90);
});

/*
 * The first death is not special, and that is CRCON's rule rather than a convenience.
 *
 * It is tempting to skip the first death on the grounds that we never saw the life begin — the
 * earlier draft of this file did exactly that, and it is wrong: CRCON seeds `last_spawn` from the
 * player's first appearance and then measures every death against it, so its first death closes a
 * life like any other. Matching that matters more than the tidier rule, because the whole point of
 * these endpoints is that a CRCON client gets the number it expects.
 */
test("the first death closes a life, measured from the round's first sighting", () => {
  const start = "2026-08-20T10:00:00.000Z";
  const at = (sec: number) => new Date(Date.parse(start) + sec * 1000).toISOString();
  // K kills D at 10s and again at 45s. D's first sighting is the 10s death itself.
  const fold = foldKillWindow([
    { kind: "evt.kill", ts: at(10), actorPlayerId: "k", actorName: "K", victimPlayerId: "d", victimName: "D", weapon: "M1" },
    { kind: "evt.kill", ts: at(45), actorPlayerId: "k", actorName: "K", victimPlayerId: "d", victimName: "D", weapon: "M1" },
  ] as any, start);
  const d = fold.get("d")!;
  assert.equal(d.longestLifeSecs, 35, "10s → 45s");
  assert.equal(d.shortestLifeSecs, 0, "the 10s death closes a zero-length life, as CRCON's does");

  // K, meanwhile, never died: no life ever closed, so both stay null rather than becoming 0.
  const k = fold.get("k")!;
  assert.equal(k.longestLifeSecs, null);
  assert.equal(k.shortestLifeSecs, null);
});

test("a player who never dies reports no lives rather than a zero", () => {
  const start = "2026-08-20T10:00:00.000Z";
  const fold = foldKillWindow([
    { kind: "evt.kill", ts: start, actorPlayerId: "ace", actorName: "Ace", victimPlayerId: "x", victimName: "X", weapon: "M1" },
  ] as any, start);
  const ace = fold.get("ace")!;
  assert.equal(ace.longestLifeSecs, null);
  assert.equal(ace.shortestLifeSecs, null);
  assert.equal(ace.lastSpawnSecs, null, "never respawned, because never died");
});

/*
 * vote_status as CRCON's VoteMap.get_status builds it (rcon/vote_map/service.py, unsorted): off is
 * its fixed "disabled" answer; on, each option is {voters, map, votes_count} in that order, and
 * next_map is the PRETTY NAME of the map the vote has put next. voters stays empty: our votes are
 * counted per option, not kept per voter.
 */
test("vote status is CRCON's VoteMapStatus: its disabled answer, its option order, a pretty next map", () => {
  assert.equal(pyDumps(buildVoteStatus({ enabled: false, paused: true, options: [{ id: "foy_warfare", name: "Foy" }], tallies: [3], overrideMapId: null, game: "hll" })),
    '{"enabled":false,"paused":false,"results":[],"last_reminder":null,"next_map":null,"player_choice":null}', "off is off, whatever the state says");
  const v = buildVoteStatus({
    enabled: true, paused: false,
    options: [{ id: "carentan_warfare", name: "Carentan" }, { id: "foy_warfare", name: "Foy" }],
    tallies: [7, 3], overrideMapId: null, game: "hll",
  }) as any;
  assert.deepEqual(Object.keys(v), ["enabled", "paused", "results", "last_reminder", "next_map", "player_choice"]);
  assert.deepEqual(Object.keys(v.results[0]), ["voters", "map", "votes_count"], "VoteMapMapResult(voters=, map=, votes_count=)");
  assert.equal(v.results[0].votes_count, 7);
  assert.deepEqual(v.results[0].voters, []);
  assert.equal(v.results[0].map.map.tag, "CAR", "each option is a full CRCON Layer");
  assert.equal(v.next_map, "Carentan Warfare", "the leader, by its pretty name");

  // A staff override beats the tally, because it is what will actually be played.
  const forced = buildVoteStatus({ enabled: true, paused: true, options: [{ id: "carentan_warfare", name: "Carentan" }], tallies: [9], overrideMapId: "kursk_warfare", game: "hll" }) as any;
  assert.equal(forced.next_map, "Kursk Warfare");
  assert.equal(forced.paused, true);

  /*
   * Before anybody has voted, CRCON already names a map: restart() applies its default pick the
   * moment a vote opens, and next_map is what was applied (rcon/vote_map/service.py v12.3.0). Ours
   * is what the round's end would apply now, the worker's rule (resolveVoteWinner): the default
   * pick is the first option of the shuffled ballot, a tie goes to the earliest, and the map in
   * play never wins. These read null, which is what the owner's live comparison showed: a running
   * vote at no votes, where CRCON's would name its pick.
   */
  const ballot = [{ id: "driel_warfare", name: "Driel" }, { id: "kursk_offensive_ger", name: "Kursk" }, { id: "foy_warfare", name: "Foy" }];
  const next = (extra: { tallies: number[]; overrideMapId?: string | null; inPlayMapId?: string | null; options?: typeof ballot }) =>
    (buildVoteStatus({ enabled: true, paused: false, options: extra.options ?? ballot, overrideMapId: null, game: "hll", ...extra }) as any).next_map;
  assert.equal(next({ tallies: [0, 0, 0] }), "Driel Warfare", "no votes: the default pick, the ballot's first option");
  assert.equal(next({ tallies: [0, 4, 4] }), "Kursk Off. GER", "a tie: the earliest of it");
  assert.equal(next({ tallies: [0, 0, 0], inPlayMapId: "DRIEL_WARFARE" }), "Kursk Off. GER", "never the map in play: that replays it");
  assert.equal(next({ tallies: [9, 0, 0], inPlayMapId: "driel_warfare" }), "Kursk Off. GER", "nor on votes for it");
  assert.equal(next({ tallies: [0, 0, 0], overrideMapId: "kursk_warfare" }), "Kursk Warfare", "an override, still first");
  assert.equal(next({ tallies: [], options: [] }), null, "no ballot open: nothing next");
});

/*
 * voters lists the in-game ballots as CRCON lists its voters (VoteMapVoter: player_id, player_name,
 * count; rcon/vote_map/service.py v12.3.0), for the vote that is up only, with ids only where the
 * server publishes them. Discord votes count in votes_count and are never listed.
 */
test("vote status lists the in-game voters as CRCON does: ids where published, this vote's only", () => {
  const ballot = [{ id: "driel_warfare", name: "Driel" }, { id: "foy_warfare", name: "Foy" }];
  const ingameVoters = { messageId: "ingame:2026-10-13T20:00:00.000Z", voters: [[{ name: "Ana", playerId: "76561198000000001" }, { name: "Bob", playerId: null }], []] };
  const status = (extra: Record<string, unknown>) => buildVoteStatus({
    enabled: true, paused: false, options: ballot, tallies: [3, 1], overrideMapId: null, game: "hll",
    ingameVoters, activeMessageId: ingameVoters.messageId, publishIds: true, ...extra,
  }) as any;
  const v = status({});
  assert.deepEqual(v.results[0].voters, [{ player_id: "76561198000000001", player_name: "Ana", count: 1 }, { player_id: null, player_name: "Bob", count: 1 }]);
  assert.deepEqual(Object.keys(v.results[0].voters[0]), ["player_id", "player_name", "count"], "VoteMapVoter's keys, in CRCON's order");
  assert.deepEqual(v.results[1].voters, [], "an option nobody typed for");
  assert.equal(v.results[0].votes_count, 3, "the count stays the whole tally: Discord votes count, unlisted");
  assert.ok(pyDumps(v).includes('"voters":[{"player_id":"76561198000000001","player_name":"Ana","count":1},{"player_id":null,"player_name":"Bob","count":1}]'), "CRCON's bytes for them");
  assert.deepEqual(status({ publishIds: false }).results[0].voters.map((x: any) => x.player_id), [null, null], "a names-only server publishes the names alone");
  assert.deepEqual(status({ activeMessageId: "ingame:2026-10-13T21:30:00.000Z" }).results[0].voters, [], "a list read for another vote is not this vote's");
  assert.deepEqual(status({ activeMessageId: null }).results[0].voters, []);
  assert.deepEqual(status({ ingameVoters: null }).results[0].voters, []);
});

/*
 * cap_flips, morale_history and match_time are what the recorder kept for the newest round
 * (apps/workers/src/cap-flips.ts), served the way CRCON serves its map recorder's: seconds since
 * the start, oldest first, CRCON's key order, and the newest round's even after it ended.
 */
test("cap_flips and morale_history are the newest round's recorded timeline", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    fake.session = { mapId: "CAR_L_1944_Conquest_Day", playerCount: 20, maxPlayerCount: 100, initialMorale: 500, alliedMorale: 470, axisMorale: 455 };
    const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      // No round on record at all: CRCON's map history is empty.
      const none = (await anon(`${base}/s/${s.id}/api/get_public_info`)).body.result as any;
      assert.equal(none.cap_flips, null);
      assert.deepEqual(none.morale_history, []);
      assert.equal(none.match_time, 0);

      const m = await repo.matches.open({ serverId: s.id, map: "CAR_L_1944_Conquest_Day", startedAt: new Date(Date.now() - 600_000).toISOString() });
      await repo.matches.recordTimeline(m.id, { flip: [30, 1, 0], morale: [30, 490, 470], matchTime: 3600, initialMorale: 500 });
      await repo.matches.recordTimeline(m.id, { flip: [400, 2, 0], morale: [400, 480, 460] });
      await new Promise((r) => setTimeout(r, 5100)); // past the live read's 5 s cache
      const info = (await anon(`${base}/s/${s.id}/api/get_public_info`)).body.result as any;
      assert.deepEqual(info.cap_flips, [{ allied_score: 1, axis_score: 0, ts: 30 }, { allied_score: 2, axis_score: 0, ts: 400 }]);
      assert.deepEqual(Object.keys(info.cap_flips[0]), ["allied_score", "axis_score", "ts"], "MapScore(allied_score=, axis_score=, ts=)");
      assert.deepEqual(info.morale_history, [{ allied_morale: 490, axis_morale: 470, ts: 30 }, { allied_morale: 480, axis_morale: 460, ts: 400 }]);
      assert.equal(info.match_time, 3600);
      assert.deepEqual([info.allied_morale, info.axis_morale, info.initial_morale], [470, 455, 500], "the morale fields are the live session's");
    } finally {
      fake.close();
    }
  });
});

/*
 * A round is read against the game it was PLAYED on.
 *
 * A map id only means something against a game's catalogue, and the scoreboard used to ask the
 * SERVER which game that was — i.e. whichever it runs today. Staff can change that (Connections →
 * the game/protocol control), and when they do, every round already recorded starts being read
 * through the wrong catalogue: a Vietnam round parsed as WW2 keeps its map name and loses its
 * FACTIONS, publishing empty strings where "us" and "nva" belong. CRCON reached the same fix in
 * v12.1.1 (parse_recorded_layer); the row carries its own game now.
 */
test("a server that switched games still reads its old rounds against the old game", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const s = await repo.servers.create({ name: "Alpha", game: "hllv", host: "127.0.0.1", port, password: "pw" } as never);
    await repo.servers.setStreamerMode(s.id, true);
    try {
      // A Vietnam round, recorded while the server was on Vietnam.
      await repo.matches.importOne({
        serverId: s.id, map: "wdevb_offensivenva_day",
        startedAt: "2026-08-01T20:00:00.000Z", endedAt: "2026-08-01T21:00:00.000Z",
        winner: "axis", result: null,
      });
      const before = ((await anon(`${base}/s/${s.id}/api/get_scoreboard_maps`)).body.result as any).maps[0];
      assert.deepEqual([before.map.map.allies.name, before.map.map.axis.name], ["us", "nva"], "a Vietnam round has Vietnam factions");

      // Staff switch the server to WW2. The round already on record did not move.
      await repo.servers.setGame(s.id, "hll", "binary-v2");
      const after = ((await anon(`${base}/s/${s.id}/api/get_scoreboard_maps`)).body.result as any).maps[0];
      assert.deepEqual([after.map.map.allies.name, after.map.map.axis.name], ["us", "nva"],
        "still Vietnam factions — read against the game it was PLAYED on, not the one the server runs now");
      assert.equal(JSON.stringify(after.map), JSON.stringify(before.map), "nothing about the stored round changed");
    } finally {
      fake.close();
    }
  });
});

/*
 * CRCON's stats job files a round's scoreboard (a Maps row) as the NEXT round starts, so the round
 * in progress — and a whistled one waiting for its successor — has none yet; a short round has one
 * like any other. scoreboards.py, rcon/workers.py, v12.3.0.
 */
test("the scoreboards list the rounds CRCON has filed, in its bytes", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    const a = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    await repo.matches.recordStart(a.id, { map: "foy_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.close(a.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "axis", alliedScore: 3, axisScore: 2, result: "`FOY Warfare` ALLIED (1 - 4) AXIS" });
    const b = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: "2026-08-01T11:01:00.000Z" });
    await repo.matches.recordStart(b.id, { map: "kursk_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.discardShort(b.id, "2026-08-01T11:02:00.000Z", "`KURSK Warfare` ALLIED (0 - 1) AXIS");
    const c = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T11:03:00.000Z" });
    await repo.matches.recordStart(c.id, { map: "carentan_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    const layer = (id: string) => JSON.stringify(crconLayer(id, "hll"));

    const list = await fetch(`${base}/s/${s.id}/api/get_scoreboard_maps`);
    assert.equal(await list.text(), '{"result":{"page":1,"page_size":100,"total":2,"maps":['
      + `{"map":${layer("kursk_warfare")},"id":${b.seq},"creation_time":"2026-08-01T11:03:00","start":"2026-08-01T11:01:00+00:00","end":"2026-08-01T11:02:00+00:00","server_number":1,"player_stats":[],"result":{"axis":1,"allied":0}},`
      + `{"map":${layer("foy_warfare")},"id":${a.seq},"creation_time":"2026-08-01T11:01:00","start":"2026-08-01T10:00:00+00:00","end":"2026-08-01T11:00:00+00:00","server_number":1,"player_stats":[],"result":{"axis":4,"allied":1}}`
      + ']},"command":"get_scoreboard_maps","arguments":null,"failed":false,"error":null,"forwards_results":null,"version":"v12.3.0"}');

    // The short round has its record; the round in progress has none yet.
    const short = await anon(`${base}/s/${s.id}/api/get_map_scoreboard?map_id=${b.seq}`);
    assert.deepEqual([short.body.failed, short.body.result.map_name, short.body.result.player_stats], [false, "kursk_warfare", []]);
    const running = await anon(`${base}/s/${s.id}/api/get_map_scoreboard?map_id=${c.seq}`);
    assert.deepEqual([running.body.failed, running.body.error, running.body.result], [true, "No map for this ID", null]);

    // What int() refuses, CRCON answers with the exception's repr().
    const missing = await anon(`${base}/s/${s.id}/api/get_map_scoreboard`);
    assert.equal(missing.body.error, `TypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'")`);
    const junk = await anon(`${base}/s/${s.id}/api/get_map_scoreboard?map_id=abc`);
    assert.equal(junk.body.error, `ValueError("invalid literal for int() with base 10: 'abc'")`);
    assert.equal((await anon(`${base}/s/${s.id}/api/get_map_scoreboard?map_id=%20${a.seq}%20`)).body.result.id, a.seq, "int() skips the spaces around a number");

    // limit and page as Python's int() reads them; server_number filters CRCON's table.
    const call = async (qs: string) => fetch(`${base}/s/${s.id}/api/get_scoreboard_maps${qs}`);
    assert.equal(((await (await call("?limit=1_0")).json()) as any).result.page_size, 10);
    assert.deepEqual(((await (await call("?limit=0")).json()) as any).result, { page: 1, page_size: 0, total: 2, maps: [] });
    assert.equal((await call("?limit=ten")).status, 500, "int('ten') raises: a server error there, and here");
    assert.deepEqual(((await (await call("?server_number=2")).json()) as any).result, { page: 1, page_size: 100, total: 0, maps: [] });
    assert.equal(((await (await call("?server_number=1")).json()) as any).result.total, 2);
    assert.deepEqual(((await (await call("?limit=1&page=2")).json()) as any).result.maps.map((m: { id: number }) => m.id), [a.seq]);
  });
});

/*
 * get_scoreboard_maps pages exactly as CRCON pages.
 *
 * CRCON's own line is `page_size = min(int(data.get("limit", 100)), 1000)`
 * (third_party/crcon/scoreboards.py). Ours read a different key with a different default and a
 * different ceiling, so three answers differed from CRCON's for the same request — and the
 * echoed page_size was wrong with them. Nothing covered the paging contract, which is how all
 * three sat there.
 */
test("get_scoreboard_maps takes limit, defaults to 100, and caps at 1000 — CRCON's numbers", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      const t0 = Date.parse("2026-08-01T00:00:00.000Z");
      for (let i = 0; i < 30; i++) {
        await repo.matches.importOne({
          serverId: s.id, map: "foy_warfare",
          startedAt: new Date(t0 + i * 3_600_000).toISOString(),
          endedAt: new Date(t0 + i * 3_600_000 + 1_800_000).toISOString(),
          winner: null, result: null,
        });
      }
      const call = async (qs: string) =>
        ((await anon(`${base}/s/${s.id}/api/get_scoreboard_maps${qs}`)).body.result as any);

      // No argument: CRCON's default is 100, not 25 — so all 30 rounds come back on one page.
      const bare = await call("");
      assert.equal(bare.page_size, 100, "the default is CRCON's 100");
      assert.equal(bare.maps.length, 30);
      assert.equal(bare.total, 30);

      // `limit` is the key CRCON reads.
      assert.equal((await call("?limit=10")).maps.length, 10);
      assert.equal((await call("?limit=10")).page_size, 10);

      // `page_size` is NOT: CRCON ignores it on the way in, so honouring it would be a divergence
      // even though it is the name of the field in the response.
      assert.equal((await call("?page_size=10")).page_size, 100, "ignored on input, exactly as CRCON ignores it");

      // The ceiling is 1000, not 100.
      assert.equal((await call("?limit=500")).page_size, 500);
      assert.equal((await call("?limit=99999")).page_size, 1000, "clamped at CRCON's ceiling");

      // Paging still walks correctly at the new default.
      const p2 = await call("?limit=20&page=2");
      assert.equal(p2.page, 2);
      assert.equal(p2.maps.length, 10, "30 rounds, 20 to a page");
    } finally {
      fake.close();
    }
  });
});

/*
 * The edges of CRCON's HTTP surface, as its stack answers them (crcon-http.ts): the arguments as
 * _get_data reads them out of Django's QueryDict, Django's own pages where a view raises or a
 * request is refused, and GET alone. The argument echoes and error texts expected here were
 * produced by Python 3 running CRCON's lines over the same query strings.
 */
test("CRCON's HTTP edges: arguments as _get_data reads them, Django's pages, GET alone", async () => {
  await withServer(async (base, repo) => {
    const s = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setStreamerMode(s.id, true);
    // Two filed rounds and the one in play.
    const a = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    await repo.matches.recordStart(a.id, { map: "foy_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.close(a.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "axis", alliedScore: 3, axisScore: 2, result: "`FOY Warfare` ALLIED (1 - 4) AXIS" });
    const b = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: "2026-08-01T11:01:00.000Z" });
    await repo.matches.recordStart(b.id, { map: "kursk_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.close(b.id, { endedAt: "2026-08-01T12:00:00.000Z", winner: "allies", alliedScore: 4, axisScore: 1, result: "`KURSK Warfare` ALLIED (4 - 1) AXIS" });
    const c = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T12:01:00.000Z" });
    await repo.matches.recordStart(c.id, { map: "carentan_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    const ordinal = (await repo.servers.list()).findIndex((x) => x.id === s.id) + 1;

    const api = `${base}/s/${s.id}/api`;
    const raw = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${api}/${path}`, init);
      return { status: res.status, type: res.headers.get("content-type"), allow: res.headers.get("allow"), text: await res.text() };
    };
    const page = async (path: string) => {
      const r = await raw(path);
      return [r.status, r.type, r.text];
    };
    const tail = ',"forwards_results":null,"version":"v12.3.0"}';
    const scoreboard = (args: string, error: string) =>
      `{"result":null,"command":"get_map_scoreboard","arguments":${args},"failed":true,"error":${JSON.stringify(error)}${tail}`;

    // A repeated key is the list of its values, and every key keeps its place ("1" stays second).
    assert.equal((await raw("get_map_scoreboard?map_id=x&1=a&map_id=y")).text, scoreboard('{"map_id":["x","y"],"1":"a"}',
      `TypeError("int() argument must be a string, a bytes-like object or a real number, not 'list'")`));
    // parse_qsl's decoding: "+" a space, a "%" that starts no pair kept, bytes that are not UTF-8 replaced.
    assert.equal((await raw("get_map_scoreboard?map_id=%41+%zz%E2%82%AC%C3&b")).text, scoreboard('{"map_id":"A %zz\u20ac\ufffd","b":""}',
      "ValueError(\"invalid literal for int() with base 10: 'A %zz\u20ac\ufffd'\")"));
    assert.equal((await raw("get_map_scoreboard?map_id=999999&&=&%2B=%2b")).text, scoreboard('{"map_id":"999999","":"","+":"+"}', "No map for this ID"));
    // An id past any round's, however long, finds none; a found round echoes its arguments as sent.
    assert.equal(JSON.parse((await raw("get_map_scoreboard?map_id=99999999999999999999")).text).error, "No map for this ID");
    assert.ok((await raw(`get_map_scoreboard?z=1&map_id=${a.seq}`)).text.endsWith(`"command":"get_map_scoreboard","arguments":{"z":"1","map_id":"${a.seq}"},"failed":false,"error":null${tail}`));

    // get_map_history's pretty: any value but an empty one, and a repeated key's list is one.
    const newest = async (qs: string) => JSON.parse((await raw(`get_map_history${qs}`)).text).result[0];
    assert.equal(typeof (await newest("?pretty=")).start, "number", "an empty pretty is false");
    assert.equal(typeof (await newest("?pretty=&pretty=")).start, "string", "a list of two empties is true");

    // get_scoreboard_maps catches nothing: what refuses the request on the way is Django's page.
    const serverError = [500, "text/html; charset=utf-8", DJANGO_500];
    for (const qs of [
      "limit=ten", "limit=5&limit=6", "page=x", "page=1&page=1", "limit=-1",
      // server_number as Postgres 12 reads text against an integer: ASCII digits, int32's range
      "server_number=1_0", "server_number=%EF%BC%91", "server_number=2147483648", "server_number=", `server_number=${ordinal}&server_number=${ordinal}`,
      // a LIMIT and OFFSET Postgres refuses, and a page number orjson cannot write
      "limit=1&page=9223372036854775809", "limit=0&page=18446744073709551616",
    ]) assert.deepEqual(await page(`get_scoreboard_maps?${qs}`), serverError, qs);
    // ...and what it takes: Postgres' spaces and sign, and Python's ints however large.
    const maps = async (qs: string) => JSON.parse((await raw(`get_scoreboard_maps?${qs}`)).text).result;
    assert.equal((await maps(`server_number=%09${ordinal}%20`)).total, 2);
    assert.equal((await maps(`server_number=%2B${ordinal}`)).total, 2);
    assert.equal((await raw("get_scoreboard_maps?limit=1&page=9223372036854775808")).text,
      `{"result":{"page":9223372036854775808,"page_size":1,"total":2,"maps":[]},"command":"get_scoreboard_maps","arguments":null,"failed":false,"error":null${tail}`);
    assert.equal((await raw("get_scoreboard_maps?limit=0&page=18446744073709551615")).text,
      `{"result":{"page":18446744073709551615,"page_size":0,"total":2,"maps":[]},"command":"get_scoreboard_maps","arguments":null,"failed":false,"error":null${tail}`);

    // More than Django's thousand fields (parse_qsl counts one more than the "&"s) is its 400 page
    // for the views that read their arguments; the others never look.
    for (const cmd of [`get_map_scoreboard?map_id=${a.seq}`, "get_scoreboard_maps?limit=1", "get_map_history?pretty="]) {
      assert.deepEqual(await page(`${cmd}${"&".repeat(1000)}`), [400, "text/html; charset=utf-8", DJANGO_400], cmd);
      assert.equal((await raw(`${cmd}${"&".repeat(999)}`)).status, 200, `${cmd}: a thousand fields are allowed`);
    }
    assert.equal((await raw(`get_version?${"&".repeat(1000)}`)).status, 200);

    // GET alone: any other method is Django's empty 405 naming GET, HEAD included; a CORS preflight
    // is django-cors-headers' empty 200. Neither looks the server up.
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await raw("get_live_scoreboard", { method });
      assert.deepEqual([r.status, r.type, r.allow, r.text], [405, "text/html; charset=utf-8", "GET", ""], method);
    }
    const head = await fetch(`${api}/get_version`, { method: "HEAD" });
    assert.deepEqual([head.status, head.headers.get("allow")], [405, "GET"]);
    const preflight = await raw("get_public_info", { method: "OPTIONS", headers: { origin: "https://overlay.example", "access-control-request-method": "GET" } });
    assert.deepEqual([preflight.status, preflight.type, preflight.text], [200, "text/html; charset=utf-8", ""]);
    assert.equal((await fetch(`${base}/s/00000000-0000-0000-0000-000000000000/api/get_version`, { method: "POST" })).status, 405, "any address alike");
    assert.equal((await fetch(`${base}/stats/nowhere/api/get_version`, { method: "POST" })).status, 405);
    assert.equal((await raw("get_players", { method: "POST" })).status, 404, "a command that is not one of these stays our own 404");

    // A failure inside: the views that catch nothing are Django's server error page, and the rest
    // answer their own envelope with `failed` set.
    const boom = async (): Promise<never> => { throw new Error("database blip"); };
    const real = { count: repo.matches.crconRoundCount, rounds: repo.matches.crconRounds, bySeq: repo.matches.crconRoundBySeq };
    try {
      repo.matches.crconRoundCount = boom;
      assert.deepEqual(await page("get_scoreboard_maps"), serverError);
      repo.matches.crconRounds = boom;
      assert.deepEqual(await page("get_map_history"), serverError);
      assert.equal((await raw("get_previous_map")).text, `{"result":null,"command":"get_previous_map","arguments":null,"failed":true,"error":"command failed"${tail}`);
      repo.matches.crconRoundBySeq = boom;
      assert.equal((await raw("get_map_scoreboard?map_id=1&x=2")).text, scoreboard('{"map_id":"1","x":"2"}', "command failed"));
    } finally {
      repo.matches.crconRoundCount = real.count;
      repo.matches.crconRounds = real.rounds;
      repo.matches.crconRoundBySeq = real.bySeq;
    }
  });
});

/*
 * CRCON's live board is worked out by a loop that writes its cache only when a pass succeeds: a
 * pass whose roster read raises, or whose roster has players but none with an id (the max() over
 * those with one raises), leaves the last snapshot standing. rcon/player_stats.py, v12.3.0.
 */
test("live scoreboard: a failed pass keeps the last snapshot, as CRCON's loop does", async () => {
  await withServer(async (base, repo) => {
    const fakeA = new FakeHllServer("pw");
    const fakeB = new FakeHllServer("pw");
    const [portA, portB] = await Promise.all([fakeA.listen(), fakeB.listen()]);
    for (const f of [fakeA, fakeB]) {
      f.session = { mapName: "foy_warfare", playerCount: 2, maxPlayerCount: 100 };
      f.players = [{ iD: "76561198000000001", name: "Able" }, { iD: "76561198000000002", name: "Baker" }];
    }
    const sa = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port: portA, password: "pw" });
    const sb = await repo.servers.create({ name: "Bravo", host: "127.0.0.1", port: portB, password: "pw" });
    for (const s of [sa, sb]) await repo.servers.setStreamerMode(s.id, true);
    try {
      const board = async (id: string) => (await fetch(`${base}/s/${id}/api/get_live_scoreboard`)).text();
      const [firstA, firstB] = await Promise.all([board(sa.id), board(sb.id)]);
      assert.equal(JSON.parse(firstA).result.stats.length, 2);
      // Alpha's roster read fails; Bravo's answers with nobody who has an id.
      fakeA.failingInfo.add("players");
      fakeB.players = [{ iD: "", name: "Able" }];
      await new Promise((r) => setTimeout(r, 5200)); // past the shared live read and the board's own pass
      assert.equal(await board(sa.id), firstA, "the last snapshot, timestamp and all, not a fresh empty one");
      assert.equal(await board(sb.id), firstB);
      // get_public_info has no roster to lose and still answers; a read of ours failing under it is
      // CRCON's server error page, not a payload with the gap filled in.
      assert.equal(JSON.parse(await (await fetch(`${base}/s/${sa.id}/api/get_public_info`)).text()).failed, false);
      const realState = repo.mapVote.getState;
      repo.mapVote.getState = async () => { throw new Error("database blip"); };
      try {
        const r = await fetch(`${base}/s/${sa.id}/api/get_public_info`);
        assert.deepEqual([r.status, await r.text()], [500, DJANGO_500]);
      } finally {
        repo.mapVote.getState = realState;
      }
    } finally {
      fakeA.close();
      fakeB.close();
    }
  });
});

/*
 * cap_flips is the round's WHOLE timeline, however long the round has run.
 *
 * CRCON publishes every flip its recorder took, and this is a parity surface: truncating a long
 * timeline would be a deviation, which on this file is itself the bug. A round left open by a
 * missed MATCH ENDED can make that a lot of samples — the answer is the narrow projection behind
 * it (three columns, no composition jsonb), never a shorter answer.
 */
test("cap_flips returns every recorded flip, even for a round that has run for days", async () => {
  await withServer(async (base, repo) => {
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    fake.session = { mapId: "foy_warfare", playerCount: 20, maxPlayerCount: 100 };
    const s = await repo.servers.create({ name: "Alpha", host: "127.0.0.1", port, password: "pw" });
    await repo.servers.setStreamerMode(s.id, true);
    try {
      const m = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() });
      const FLIPS = 1600; // CRCON publishes every flip its recorder took; so does this
      for (let i = 0; i < FLIPS; i++) await repo.matches.recordTimeline(m.id, { flip: [i * 60, i % 2, (i + 1) % 2] });
      const flips = ((await anon(`${base}/s/${s.id}/api/get_public_info`)).body.result as any).cap_flips as any[];
      assert.equal(flips.length, FLIPS, "every flip, not a capped window — this is a parity surface");
      assert.equal(flips[0].ts, 0, "oldest first, seconds since the start");
      assert.equal(flips.at(-1)!.ts, (FLIPS - 1) * 60, "through to the newest");
    } finally {
      fake.close();
    }
  });
});

/*
 * The in-game vote counters, and the row shape CRCON actually puts on the wire.
 *
 * These three sat at null on the reasoning that our map vote is a Discord poll with no per-round
 * in-game counts. That was true and irrelevant: the fields are the GAME's vote-kick system, which
 * we ingest as evt.vote.* like CRCON does. The same mistake as the lifespans — "we don't hold it"
 * asserted without checking what CRCON derives it from.
 */

