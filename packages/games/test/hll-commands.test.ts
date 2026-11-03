import { test } from "node:test";
import assert from "node:assert/strict";
import { HLL_BINARY_V2, commandDef, isWrite, type LogicalCommand } from "../src/hll/commands.ts";
import { wireMismatches, SHARED_WIRE_ALLOWANCES } from "./wire-probe.ts";

const legacy = (cmd: LogicalCommand, params: Record<string, unknown> = {}) => commandDef(cmd).legacyText!.build(params);

test("every command has at least one wire; every write has an authoritative legacy wire", () => {
  // Writes that exist ONLY in the v2 protocol — legacy RCON has no equivalent command at all, so a
  // missing legacy wire is the truth, not an omission. Anything else added here needs the same
  // justification.
  // setMapShuffleEnabled: legacy text can only TOGGLE shuffle (togglemapshuffle, kept on its own
  // key), and a toggle standing in for a set would turn an already-off shuffle on.
  const v2OnlyWrites = new Set<string>(["setSectorLayout", "setMapShuffleEnabled"]);
  // The one deliberately WIRELESS entry: RemoveSectorLayout exists only in Vietnam's protocol
  // (p11 — WW2 stores no layouts, so there is nothing its wire could mean). The HLL key exists
  // so the two tables stay key-identical (the delta guard), and executing it on HLL fails with
  // the transport's own "not mapped" instead of a fabricated verb the server would 200-and-ignore.
  const vietnamOnly = new Set<string>(["removeSectorLayout"]);
  for (const [name, def] of Object.entries(HLL_BINARY_V2)) {
    assert.equal(def.logical, name);
    if (vietnamOnly.has(name)) { assert.ok(!def.legacyText && !def.binaryV2, `${name} must stay wireless on HLL`); continue; }
    assert.ok(def.legacyText || def.binaryV2, `${name} has no wire at all`);
    // All other writes come from Commands.xml, so they must have a legacy template.
    if (def.access === "write" && !v2OnlyWrites.has(name)) assert.ok(def.legacyText, `write ${name} missing legacyText`);
  }
  // getObjectives is the known v2-only read (legacy needs 5 objectiverow_N calls).
  assert.equal(HLL_BINARY_V2.getObjectives.legacyText, undefined);
});

test("legacy templates match Commands.xml (authoritative)", () => {
  assert.equal(legacy("changeMap", { mapName: "CAR_S_1944_Day_P_Skirmish" }), "map CAR_S_1944_Day_P_Skirmish");
  assert.equal(legacy("addAdmin", { playerId: "765611", group: "senior", comment: "Kreitz" }), 'adminadd "765611" "senior" "Kreitz"');
  assert.equal(legacy("removeAdmin", { playerId: "765611" }), "admindel 765611");
  assert.equal(legacy("broadcast", { message: "hello" }), "broadcast hello");
  assert.equal(legacy("addVip", { playerId: "76561198000000001", description: "donor" }), 'vipadd "76561198000000001" "donor"');
  assert.equal(legacy("removeVip", { playerId: "76561198000000001" }), "vipdel 76561198000000001");
  assert.equal(legacy("addAdmin", { playerId: "id", group: "admin", comment: "note" }), 'adminadd "id" "admin" "note"');
  assert.equal(legacy("setKickIdleTime", { minutes: 5 }), "setkickidletime 5");
  assert.equal(legacy("setMaxQueuedPlayers", { count: 4 }), "setmaxqueuedplayers 4");
  assert.equal(legacy("addMapToRotation", { mapName: "carentan_warfare", after: "foy_warfare" }), "rotadd carentan_warfare foy_warfare");
  assert.equal(legacy("addMapToRotation", { mapName: "carentan_warfare" }), "rotadd carentan_warfare");
  assert.equal(legacy("removeMapFromRotation", { mapName: "foy_warfare" }), "rotdel foy_warfare");
  assert.equal(legacy("switchTeamNow", { playerId: "Bob" }), 'switchteamnow "Bob"');
  assert.equal(legacy("resetVoteKickThreshold"), "resetvotekickthreshold");
});

test("boolean config commands encode on/off", () => {
  assert.equal(legacy("setAutoBalanceEnabled", { enabled: true }), "setautobalanceenabled on");
  assert.equal(legacy("setAutoBalanceEnabled", { enabled: false }), "setautobalanceenabled off");
  assert.equal(legacy("setVoteKickEnabled", { enabled: "on" }), "setvotekickenabled on");
});

test("ban removal uses the pardon* templates (fixes the earlier stub)", () => {
  assert.equal(legacy("removeTempBan", { playerId: "banref" }), "pardontempban banref");
  assert.equal(legacy("removePermaBan", { playerId: "banref" }), "pardonpermaban banref");
});

test("read getters are read; setters/actions are write", () => {
  for (const r of ["getVipIds", "getTempBans", "getMapRotation", "getAutoBalanceEnabled", "getSlots"] as LogicalCommand[]) {
    assert.equal(isWrite(r), false, `${r} should be read`);
  }
  for (const w of ["changeMap", "addVip", "setAutoBalanceEnabled", "broadcast", "removeMapFromRotation"] as LogicalCommand[]) {
    assert.equal(isWrite(w), true, `${w} should be write`);
  }
});

test("getters carry the exact 'get …' legacy template and no v2 wire", () => {
  assert.equal(legacy("getTempBans"), "get tempbans");
  assert.equal(legacy("getVipIds"), "get vipids");
  assert.equal(legacy("getMapRotation"), "get mapsinrotation");
});

test("confirmed v2 write wires carry the exact command name + body schema", () => {
  assert.equal(commandDef("changeMap").binaryV2?.name, "ChangeMap");
  assert.equal(commandDef("kickPlayer").binaryV2?.name, "KickPlayer");
  // Setters now have confirmed v2 wires (names + body field schemas from the v2 client).
  assert.deepEqual(commandDef("setAutoBalanceEnabled").binaryV2?.content({ enabled: true }), { Enable: true });
  assert.deepEqual(commandDef("setAutoBalanceEnabled").binaryV2?.content({ enabled: "off" }), { Enable: false });
  assert.deepEqual(commandDef("setHighPing").binaryV2?.content({ ms: 500 }), { HighPingThresholdMs: 500 });
  assert.deepEqual(commandDef("addVip").binaryV2?.content({ playerId: "id", description: "d" }), { PlayerId: "id", Comment: "d" });
  assert.deepEqual(commandDef("addAdmin").binaryV2?.content({ playerId: "id", group: "admin", comment: "c" }), { PlayerId: "id", AdminGroup: "admin", Comment: "c" });
  assert.deepEqual(commandDef("switchTeamNow").binaryV2?.content({ playerId: "id" }), { PlayerId: "id", ForceMode: 1 });
  assert.deepEqual(commandDef("switchTeamOnDeath").binaryV2?.content({ playerId: "id" }), { PlayerId: "id", ForceMode: 0 });
  assert.deepEqual(commandDef("banProfanity").binaryV2?.content({ words: "a, b ,c" }), { BannedWords: ["a", "b", "c"] });
  /*
   * The censor push sends a LIST under `words`, on both halves of the wire. The legacy template
   * read only `p.word`, so it rendered "unbanprofanity " with nothing after it — a removal that
   * took nothing off the server's list while the app recorded it as applied, and no banned-words
   * getter to ever catch the drift.
   */
  assert.deepEqual(commandDef("unbanProfanity").binaryV2?.content({ words: ["a", "b"] }), { BannedWords: ["a", "b"] });
  assert.equal(legacy("unbanProfanity", { words: ["a", "b"] }), "unbanprofanity a,b");
  assert.equal(legacy("unbanProfanity", { word: "a" }), "unbanprofanity a", "the singular form still works");
  assert.equal(legacy("banProfanity", { words: ["a", "b"] }), "banprofanity a,b", "and its sibling is unchanged");
  assert.deepEqual(commandDef("resetVoteKickThreshold").binaryV2?.content({}), {});
});

test("every write now has a binary-v2 wire (full v2 admin surface)", () => {
  for (const [name, def] of Object.entries(HLL_BINARY_V2)) {
    if (def.access !== "write") continue;
    if (name === "toggleMapShuffle") continue; // v2 equivalent is a set, not a toggle
    if (name === "removeSectorLayout") continue; // Vietnam-only verb — wireless on HLL on purpose (see the wire test above)
    assert.ok(def.binaryV2, `write ${name} is missing its binary-v2 wire`);
  }
});

test("direct-match v2 getters are wired to their GetDisplayableCommands names with an empty body", () => {
  const expected: Partial<Record<LogicalCommand, string>> = {
    getTempBans: "GetTemporaryBans",
    getPermaBans: "GetPermanentBans",
    getAdminIds: "GetAdminUsers",
    getAdminGroups: "GetAdminGroups",
    getAutoBalanceEnabled: "GetAutoBalanceEnabled",
    getAutoBalanceThreshold: "GetAutoBalanceThreshold",
    getIdleKickTime: "GetKickIdleDuration",
    getHighPing: "GetHighPingThreshold",
    getTeamSwitchCooldown: "GetTeamSwitchCooldown",
    getVoteKickEnabled: "GetVoteKickEnabled",
    getVoteKickThreshold: "GetVoteKickThreshold",
  };
  for (const [logical, name] of Object.entries(expected)) {
    const wire = commandDef(logical as LogicalCommand).binaryV2;
    assert.equal(wire?.name, name, `${logical} should map to ${name}`);
    assert.deepEqual(wire?.content({}), {}, `${logical} getter takes no body`);
    assert.equal(isWrite(logical as LogicalCommand), false, `${logical} is a read`);
  }
  // getMaxQueuedPlayers/getNumVipSlots/getProfanity have no standalone v2 getter. getVipIds has
  // no standalone getter either, but rides GetServerInformation's vipplayers info request
  // (confirmed live 2026-08-15) — the wire the VIP reconciler reads through.
  assert.equal(commandDef("getMaxQueuedPlayers").binaryV2, undefined);
  assert.deepEqual(commandDef("getVipIds").binaryV2?.content({}), { Name: "vipplayers", Value: "" });
  assert.equal(commandDef("getVipIds").binaryV2?.name, "GetServerInformation");
});

/*
 * GetClientReferenceData is one wire command answering about MANY others: the body names the
 * command you are asking about, and the answer is that command's option list. Three of ours ride on
 * it, and the bug this pins is what happens when two of them get conflated — the map catalogue was
 * read from AddMapToRotation's list and then fed to ChangeMap, which on a build where the two lists
 * differ answers 200 and does nothing. So: same wire, three DIFFERENT questions, and the question
 * is the whole payload.
 */
test("each client-reference read asks about its own command", () => {
  const asked: Record<string, string> = {
    getMapReferenceList: "AddMapToRotation",
    getChangeMapList: "ChangeMap",
    getObjectiveRows: "SetSectorLayout",
  };
  for (const [logical, about] of Object.entries(asked)) {
    const wire = commandDef(logical as LogicalCommand).binaryV2;
    assert.equal(wire?.name, "GetClientReferenceData", `${logical} rides GetClientReferenceData`);
    assert.equal(wire?.content({}), about, `${logical} must ask about ${about}, not another command's options`);
    assert.equal(isWrite(logical as LogicalCommand), false, `${logical} is a read`);
  }
  assert.notEqual(asked.getMapReferenceList, asked.getChangeMapList,
    "the rotation list and the change-map list are separate questions — that is the point");
});

test("commandDef throws on an unknown command", () => {
  assert.throws(() => commandDef("nope" as LogicalCommand), /Unknown logical command/);
});

test("a command's two wires read the same parameters, or say why they do not", () => {
  // See wire-probe.ts: two shipped bugs lived in the gap between a command's two wires, where no
  // test looked because each wire is correct read on its own.
  const { offenders, staleAllowances } = wireMismatches(HLL_BINARY_V2, SHARED_WIRE_ALLOWANCES);
  assert.deepEqual(offenders, [], "each of these sends a different thing depending on the protocol");
  assert.deepEqual(staleAllowances, [], "these no longer differ — drop them from SHARED_WIRE_ALLOWANCES");
});

/*
 * The capability probe's discovery read. `GetDisplayableCommands` is how the running server
 * enumerates its own verbs — the official client opens every session with it, and it is the only
 * place a game update's additions are visible (the shipped client carries no list). v2-only by
 * nature: the legacy protocol's surface IS Commands.xml, there is nothing to enumerate.
 */
test("the capability probe's discovery read is wired, v2-only, and the baseline is sane", async () => {
  const { V2_CATALOGUE_503 } = await import("../src/hll/commands.ts");
  const def = HLL_BINARY_V2.getServerCommands;
  assert.equal(def.access, "read");
  assert.equal(def.binaryV2?.name, "GetDisplayableCommands");
  assert.equal(def.legacyText, undefined, "legacy text has no catalogue to enumerate");
  // The baseline the probe diffs a live server against: it must know the discovery call itself
  // (else every probe would report its own command as an update addition) and carry no duplicate
  // rows that would double-count the diff.
  assert.ok(V2_CATALOGUE_503.includes("GetDisplayableCommands"));
  assert.ok(V2_CATALOGUE_503.includes("SetDynamicWeatherEnabled"), "the known-unwired verbs are baseline, not 'new'");
  assert.equal(new Set(V2_CATALOGUE_503).size, V2_CATALOGUE_503.length, "duplicate baseline entries");
});

/*
 * The rotation page's "Check from game" asks for two things beside the rotation: the game's own
 * play queue and whether it is shuffled. Both are reads (an observe-mode server must still answer
 * them), and both are verbs the live 5.03 catalogue lists — a name it lacks would be refused by
 * every server and show as "unknown" forever.
 */
test("the game's play queue and shuffle switch are wired as reads the server knows", async () => {
  const { V2_CATALOGUE_503 } = await import("../src/hll/commands.ts");
  const seq = HLL_BINARY_V2.getMapSequence;
  assert.equal(seq.access, "read");
  assert.equal(seq.binaryV2?.name, "GetServerInformation");
  assert.deepEqual(seq.binaryV2?.content({}), { Name: "mapsequence", Value: "" });
  assert.equal(seq.legacyText?.build({}), "listcurrentmapsequence");
  const shuffle = HLL_BINARY_V2.getMapShuffleEnabled;
  assert.equal(shuffle.access, "read");
  assert.equal(shuffle.binaryV2?.name, "GetMapShuffleEnabled");
  assert.equal(shuffle.legacyText?.build({}), "querymapshuffle");
  assert.ok(V2_CATALOGUE_503.includes("GetMapShuffleEnabled"));
  assert.ok(V2_CATALOGUE_503.includes("GetServerInformation"));
});

/*
 * Map shuffle as a SET, for the Live settings switch. No legacy wire on purpose: legacy text only
 * TOGGLES, and a toggle sent to switch shuffle off turns a shuffle that is already off on.
 */
test("map shuffle is set, never toggled: a v2 set with no legacy wire", async () => {
  const { V2_CATALOGUE_503 } = await import("../src/hll/commands.ts");
  const def = HLL_BINARY_V2.setMapShuffleEnabled;
  assert.equal(def.access, "write", "observe mode must refuse it");
  assert.equal(def.binaryV2?.name, "SetMapShuffleEnabled");
  assert.deepEqual(def.binaryV2?.content({ enabled: false }), { Enable: false });
  assert.deepEqual(def.binaryV2?.content({ enabled: true }), { Enable: true });
  assert.equal(def.legacyText, undefined, "a toggle is not a set");
  assert.ok(V2_CATALOGUE_503.includes("SetMapShuffleEnabled"));
});
