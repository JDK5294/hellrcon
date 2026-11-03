import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSession, queueDepth, vipQueueDepth } from "../dist/session.js";

test("session: binary v2 keys, including the acronym the server mangles", () => {
  // The wire lowercases only the FIRST character of the C# name, so `VIPQueueCount` arrives as
  // `vIPQueueCount`. Reading `vipQueueCount` got undefined, which every caller showed as 0 — the
  // VIP queue was structurally incapable of reporting anyone.
  const s = normalizeSession({
    serverName: "Lynx", mapName: "FOY", gameMode: "Warfare",
    playerCount: 98, maxPlayerCount: 100, alliedPlayerCount: 49, axisPlayerCount: 49,
    alliedScore: 2, axisScore: 3, remainingMatchTime: 4548,
    queueCount: 4, maxQueueCount: 6, vIPQueueCount: 2, maxVIPQueueCount: 5,
  });
  assert.equal(s.queueCount, 4);
  assert.equal(s.vipQueueCount, 2, "the mangled acronym key is read");
  assert.equal(s.maxVipQueueCount, 5);
  assert.equal(s.playerCount, 98);
  assert.equal(s.alliedScore, 2);
  assert.equal(s.mapName, "FOY");
});

test("session: the CRCON bridge's snake_case gamestate reads the same", () => {
  const s = normalizeSession({
    map_name: "CARENTAN", game_mode: "Warfare",
    num_allied_players: 24, num_axis_players: 25, max_players: 100,
    allied_score: 4, axis_score: 1, queue_count: 3, vip_queue_count: 1,
  });
  assert.equal(s.alliedPlayerCount, 24);
  assert.equal(s.axisPlayerCount, 25);
  assert.equal(s.queueCount, 3);
  assert.equal(s.vipQueueCount, 1);
  assert.equal(s.alliedScore, 4);
  assert.equal(s.mapName, "CARENTAN");
});

test("session: a missing field stays missing, and a real zero survives", () => {
  // "the server did not say" and "the server said none" are different answers, and only one of
  // them is safe to render as a number.
  const s = normalizeSession({ queueCount: 0 });
  assert.equal(s.queueCount, 0, "an honest zero is kept");
  assert.equal(s.vipQueueCount, undefined, "an absent field is not invented as 0");
  assert.equal(s.mapName, undefined);
  assert.deepEqual(normalizeSession(null), {});
  assert.deepEqual(normalizeSession("nope"), {});
});

// Captured verbatim from a live 100-slot 5.0.3 server, mid-round. Kept whole rather than trimmed
// to the interesting keys: it is the only ground truth we have about what this build actually sends.
const LIVE_SESSION = {
  serverName: "The [LYNX] Division #1", mapName: "SAINTE-MÈRE-ÉGLISE",
  mapId: "stmereeglise_offensive_us", gameMode: "Offensive",
  remainingMatchTime: 567, matchTime: 5400,
  alliedFaction: 1, axisFaction: 0, alliedScore: 3, axisScore: 2,
  initialMorale: 0, alliedMorale: 0, axisMorale: 0,
  playerCount: 100, alliedPlayerCount: 50, axisPlayerCount: 50, maxPlayerCount: 100,
  queueCount: 6, maxQueueCount: 6, vipQueueCount: 742, maxVipQueueCount: 2,
};

test("session: the live payload reads, including the raw map id", () => {
  const s = normalizeSession(LIVE_SESSION);
  assert.equal(s.mapId, "stmereeglise_offensive_us", "the exact id, not just the printable name");
  assert.equal(s.mapName, "SAINTE-MÈRE-ÉGLISE");
  assert.equal(s.gameMode, "Offensive");
  assert.equal(s.playerCount, 100);
  assert.equal(s.queueCount, 6);
  assert.equal(s.maxQueueCount, 6);
  assert.equal(s.remainingMatchTime, 567);
  // This build sends plain `vipQueueCount` — no mangled acronym — and the normalizer keeps the
  // server's number untouched. Interpreting it is a separate job.
  assert.equal(s.vipQueueCount, 742);
  assert.equal(s.maxVipQueueCount, 2);
});

test("VIP queue depth: a count that cannot be a queue is unknown, not a number to show", () => {
  // The bug this exists for: 742 against a declared maximum of 2, on a 100-slot server. The field
  // is carrying the VIP LIST size; the panel printed it as "742 VIP queue".
  assert.equal(vipQueueDepth(normalizeSession(LIVE_SESSION)), undefined);

  // A believable depth is believed, including a full queue and an honest zero.
  assert.equal(vipQueueDepth({ vipQueueCount: 2, maxVipQueueCount: 2 }), 2);
  assert.equal(vipQueueDepth({ vipQueueCount: 0, maxVipQueueCount: 2 }), 0);
  assert.equal(vipQueueDepth({ vipQueueCount: 1, maxVipQueueCount: 5 }), 1);

  // No declared VIP maximum: the server's own capacity is the sanity bound.
  assert.equal(vipQueueDepth({ vipQueueCount: 3, maxPlayerCount: 100 }), 3);
  assert.equal(vipQueueDepth({ vipQueueCount: 742, maxPlayerCount: 100 }), undefined);
  // Nothing to check it against — take the server at its word rather than inventing a limit.
  assert.equal(vipQueueDepth({ vipQueueCount: 3 }), 3);

  // Absent stays absent; nonsense is not rendered.
  assert.equal(vipQueueDepth({}), undefined);
  assert.equal(vipQueueDepth({ vipQueueCount: -1 }), undefined);
});

test("session: a wrapped payload is unwrapped once", () => {
  const s = normalizeSession({ result: { mapName: "STE MERE EGLISE", queueCount: 7 } });
  assert.equal(s.mapName, "STE MERE EGLISE");
  assert.equal(s.queueCount, 7);
});

/*
 * Conquest's three morale fields — typed in the response shapes since the Vietnam capture, read
 * since Update 21 made Conquest a WW2 mode. Every observed spelling, and absence stays absent
 * (an old build's session must not read as morale 0).
 */
test("normalizeSession reads morale in every spelling, and absence stays absent", () => {
  const v2 = normalizeSession({ initialMorale: 5000, alliedMorale: 4100, axisMorale: 2600 });
  assert.deepEqual([v2.initialMorale, v2.alliedMorale, v2.axisMorale], [5000, 4100, 2600]);
  const pascal = normalizeSession({ InitialMorale: 5000, AlliedMorale: 1, AxisMorale: 0 });
  assert.deepEqual([pascal.initialMorale, pascal.alliedMorale, pascal.axisMorale], [5000, 1, 0], "a real 0 is kept");
  const bridge = normalizeSession({ initial_morale: 300, allied_morale: 10, axis_morale: 20 });
  assert.deepEqual([bridge.initialMorale, bridge.alliedMorale, bridge.axisMorale], [300, 10, 20]);
  const legacy = normalizeSession({ serverName: "old build" });
  assert.deepEqual([legacy.initialMorale, legacy.alliedMorale, legacy.axisMorale], [undefined, undefined, undefined]);
});

test("queueDepth: the general queue, believed within its own size or the server's", () => {
  assert.equal(queueDepth({ queueCount: 4, maxQueueCount: 6 }), 4);
  assert.equal(queueDepth({ queueCount: 6, maxQueueCount: 6 }), 6, "a full queue");
  assert.equal(queueDepth({ queueCount: 0, maxQueueCount: 6 }), 0, "an honest zero");
  assert.equal(queueDepth({ queueCount: 9, maxQueueCount: 6 }), undefined, "past its own size it is not a queue");
  assert.equal(queueDepth({ queueCount: 3, maxPlayerCount: 100 }), 3);
  assert.equal(queueDepth({ queueCount: 742, maxPlayerCount: 100 }), undefined);
  assert.equal(queueDepth({ queueCount: 3 }), 3, "nothing to check it against");
  assert.equal(queueDepth({}), undefined);
  assert.equal(queueDepth({ queueCount: -1 }), undefined);
  assert.equal(queueDepth({ queueCount: 2.5, maxQueueCount: 6 }), undefined, "people come whole");
  assert.equal(vipQueueDepth({ vipQueueCount: 1.5, maxVipQueueCount: 2 }), undefined, "so do VIPs");
  // The live read: six waiting in a queue of six, while its VIP counter carries the VIP list.
  const live = normalizeSession({ queueCount: 6, maxQueueCount: 6, vipQueueCount: 742, maxVipQueueCount: 2, maxPlayerCount: 100 });
  assert.equal(queueDepth(live), 6);
  assert.equal(vipQueueDepth(live), undefined);
});
