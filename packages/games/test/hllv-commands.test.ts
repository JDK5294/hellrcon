import { test } from "node:test";
import assert from "node:assert/strict";
// Compiled output, not src: the tables carry relative `.js` imports that only resolve after a
// build, and what ships is what should be under test anyway.
import { HLL_BINARY_V2, HLLV_BINARY_V2, HLLV_DIVERGENT_COMMANDS, HLLV_GAME, HLL_GAME } from "../dist/index.js";
import { wireMismatches, SHARED_WIRE_ALLOWANCES } from "./wire-probe.ts";

/**
 * These tests exist because Vietnam's table used to BE HLL's, and the failure that made that a bug
 * is invisible at runtime: a v2 server handed a body it does not recognise applies it to nothing
 * and answers 200. Nothing downstream can tell that apart from success, so the wire is the only
 * place the difference can be caught, and it has to be caught here.
 *
 * Every expectation below cites `docs/hll-vietnam/rcon-v2.txt` (Team 17's published Vietnam RCON
 * document) — the same source the table's comments cite.
 */

const v2 = (table: typeof HLL_BINARY_V2 | typeof HLLV_BINARY_V2, cmd: string) =>
  (table as Record<string, { binaryV2?: { name: string; content: (p: Record<string, unknown>) => unknown } }>)[cmd]!.binaryV2!;

test("the two games are separate tables, and the module uses Vietnam's", () => {
  assert.notEqual(HLLV_BINARY_V2, HLL_BINARY_V2, "sharing the object is the bug this file guards");
  assert.equal(HLLV_GAME.commands, HLLV_BINARY_V2);
  assert.equal(HLL_GAME.commands, HLL_BINARY_V2);
});

test("Vietnam covers every logical command HLL does — a delta, never a subset", () => {
  // A missing key is not a smaller table, it is a command that throws "Unknown logical command"
  // the first time a shared route reaches for it.
  assert.deepEqual(Object.keys(HLLV_BINARY_V2).sort(), Object.keys(HLL_BINARY_V2).sort());
});

test("commands the document does not diverge on are HLL's exact definition", () => {
  // Identity, not deep-equality: this is what keeps a future fix to a shared wire landing on both
  // games at once, which is the whole reason this is an override map and not a second copy.
  for (const [name, def] of Object.entries(HLL_BINARY_V2)) {
    if (HLLV_DIVERGENT_COMMANDS.includes(name)) continue;
    assert.equal((HLLV_BINARY_V2 as Record<string, unknown>)[name], def, `${name} should be shared with HLL verbatim`);
  }
});

test("the welcome message is SetNoticeMessage — Vietnam has no SetWelcomeMessage (p7, p18)", () => {
  assert.equal(v2(HLLV_BINARY_V2, "setWelcomeMessage").name, "SetNoticeMessage");
  assert.deepEqual(v2(HLLV_BINARY_V2, "setWelcomeMessage").content({ message: "welcome" }), { Message: "welcome" });
  // HLL keeps its own, live-confirmed name. This pair is the regression: they must not converge.
  assert.equal(v2(HLL_BINARY_V2, "setWelcomeMessage").name, "SetWelcomeMessage");
});

test("BannedWords is a comma-separated string here, an array on HLL (p30)", () => {
  assert.equal(v2(HLLV_BINARY_V2, "banProfanity").name, "AddBannedWords");
  assert.deepEqual(v2(HLLV_BINARY_V2, "banProfanity").content({ words: "a, b ,c" }), { BannedWords: "a,b,c" });
  assert.deepEqual(v2(HLLV_BINARY_V2, "unbanProfanity").content({ word: "a" }), { BannedWords: "a" });
  // An array in, a string out: the panel may hand either, the wire only takes one.
  assert.deepEqual(v2(HLLV_BINARY_V2, "banProfanity").content({ words: ["a", "b"] }), { BannedWords: "a,b" });
  assert.deepEqual(v2(HLL_BINARY_V2, "banProfanity").content({ words: "a, b ,c" }), { BannedWords: ["a", "b", "c"] });
});

test("SetSectorLayout carries a MapId and Int32 sector indices (p11)", () => {
  const body = v2(HLLV_BINARY_V2, "setSectorLayout").content({
    mapId: "wdeve_offensiveus_day",
    sector1: "Hill", sector2: "Church", sector3: "Docks", sector4: "Farm", sector5: "Bridge",
    sector1Index: 0, sector2Index: 2, sector3Index: 1, sector4Index: 2, sector5Index: 0,
  });
  assert.deepEqual(body, {
    MapId: "wdeve_offensiveus_day",
    Sector_1: 0, Sector_2: 2, Sector_3: 1, Sector_4: 2, Sector_5: 0,
  });
  // HLL still sends the option strings and no map — its form applies to the running round.
  const hll = v2(HLL_BINARY_V2, "setSectorLayout").content({ sector1: "Hill", sector2: "Church", sector3: "Docks", sector4: "Farm", sector5: "Bridge" }) as Record<string, unknown>;
  assert.equal(hll.Sector_1, "Hill");
  assert.equal(hll.MapId, undefined);
});

test("Vietnam's info-request reads are wired to GetServerInformation (p19-20)", () => {
  // On a binary-v2 connection a legacy-only command throws outright, so on Vietnam — where
  // binary-v2 is the native protocol — each of these was simply unavailable.
  // getVipIds since grew a v2 wire on HLL too (live probe 2026-08-15) — both games ask the same
  // question now, which is what lets the VIP reconciler read every server.
  assert.deepEqual(HLL_BINARY_V2.getVipIds.binaryV2?.content({}), { Name: "vipplayers", Value: "" });
  assert.equal(HLL_BINARY_V2.getProfanity.binaryV2, undefined);
  assert.equal(HLL_BINARY_V2.getPlayerInfo.binaryV2, undefined);

  assert.deepEqual(v2(HLLV_BINARY_V2, "getVipIds").content({}), { Name: "vipplayers", Value: "" });
  assert.deepEqual(v2(HLLV_BINARY_V2, "getProfanity").content({}), { Name: "bannedwords", Value: "" });
  // The player id rides in Value — that is what makes this a per-player read rather than a list.
  assert.deepEqual(v2(HLLV_BINARY_V2, "getPlayerInfo").content({ playerId: "0002abc" }), { Name: "player", Value: "0002abc" });
  for (const cmd of ["getVipIds", "getProfanity", "getPlayerInfo"]) {
    assert.equal(v2(HLLV_BINARY_V2, cmd).name, "GetServerInformation");
    assert.equal((HLLV_BINARY_V2 as Record<string, { access: string }>)[cmd]!.access, "read");
  }
});

test("map shuffle is a set on Vietnam, not a toggle (p6, p13)", () => {
  assert.equal(HLL_BINARY_V2.toggleMapShuffle.binaryV2, undefined, "HLL's v2 has no shuffle setter");
  assert.equal(v2(HLLV_BINARY_V2, "toggleMapShuffle").name, "SetMapShuffleEnabled");
  assert.deepEqual(v2(HLLV_BINARY_V2, "toggleMapShuffle").content({ enabled: true }), { Enable: true });
  assert.deepEqual(v2(HLLV_BINARY_V2, "toggleMapShuffle").content({ enabled: "off" }), { Enable: false });
});

test("objectives read through GetSectorLayout — Vietnam has no 'objectives' info request (p11, p19-20)", () => {
  assert.equal(v2(HLL_BINARY_V2, "getObjectives").name, "GetServerInformation");
  assert.equal(v2(HLLV_BINARY_V2, "getObjectives").name, "GetSectorLayout");
  assert.deepEqual(v2(HLLV_BINARY_V2, "getObjectives").content({}), {});
});

test("the ban commands are identical — the PDF documents them unchanged (p27-28)", () => {
  // Worth pinning explicitly: these are the actions staff reported trouble with, and the answer is
  // that the WIRE is not where Vietnam differs. Anything that moves them needs a live capture.
  for (const cmd of ["tempBanPlayer", "permaBanPlayer", "removeTempBan", "removePermaBan", "getTempBans", "getPermaBans"]) {
    assert.equal((HLLV_BINARY_V2 as Record<string, unknown>)[cmd], (HLL_BINARY_V2 as Record<string, unknown>)[cmd], `${cmd} must stay shared`);
  }
  assert.deepEqual(v2(HLLV_BINARY_V2, "removePermaBan").content({ playerId: "0002abc" }), { PlayerId: "0002abc" });
  assert.deepEqual(v2(HLLV_BINARY_V2, "removeTempBan").content({ playerId: "0002abc" }), { PlayerId: "0002abc" });
});

test("legacy-text templates carry over untouched — Vietnam ships the same Commands.xml", () => {
  for (const name of HLLV_DIVERGENT_COMMANDS) {
    const ours = (HLLV_BINARY_V2 as Record<string, { legacyText?: unknown }>)[name]!;
    const theirs = (HLL_BINARY_V2 as Record<string, { legacyText?: unknown }>)[name]!;
    assert.equal(ours.legacyText, theirs.legacyText, `${name} must keep HLL's legacy wire (or its absence)`);
  }
});

test("the table is frozen — one game's wire cannot be edited into the other's", () => {
  assert.ok(Object.isFrozen(HLLV_BINARY_V2));
});

test("Vietnam's two wires read the same parameters too — it inherits HLL's legacy templates", () => {
  /*
   * Vietnam borrows HLL's legacy wires by reference but overrides several v2 BODIES of its own
   * (the banned-words pair send a comma string rather than an array, p30). An override is exactly
   * where the two halves can drift apart without either looking wrong, so the same probe runs here.
   */
  const { offenders, staleAllowances } = wireMismatches(HLLV_BINARY_V2, {
    ...SHARED_WIRE_ALLOWANCES,
    // HLL's legacy verb is a toggle and takes nothing; Vietnam's v2 equivalent is a set. The
    // existing wire tests above already treat this pair as deliberately different.
    toggleMapShuffle: "legacy togglemapshuffle takes no argument; the v2 form is a set",
  });
  assert.deepEqual(offenders, [], "each of these sends a different thing depending on the protocol");
  assert.deepEqual(staleAllowances, [], "these no longer differ — drop them from the allow-list");
});

/*
 * Map shuffle is an ordinary game setting in both games — Live settings shows it and an Auto
 * settings profile may set it — read with the getter and written with the SET, never the legacy
 * toggle (which would turn an already-off shuffle on).
 */
test("both games carry map shuffle as a setting, written with the set command", () => {
  for (const game of [HLL_GAME, HLLV_GAME]) {
    const f = game.descriptor.configFields.find((c) => c.field === "mapShuffle");
    assert.ok(f, `${game.id} has the map shuffle setting`);
    assert.equal(f!.kind, "bool");
    assert.equal(f!.write?.command, "setMapShuffleEnabled", "the set, not the legacy toggle");
    assert.equal(f!.read?.command, "getMapShuffleEnabled");
  }
  // Vietnam inherits the set from HLL's table: same documented wire (p13).
  assert.deepEqual(HLLV_BINARY_V2.setMapShuffleEnabled?.binaryV2?.content({ enabled: false }), { Enable: false });
});
