import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusEmbed, sectorBar, clock } from "../dist/status-board.js";

const SIDES = [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }];
const TOTALS = { allies: { players: 49, kills: 300, deaths: 280 }, axis: { players: 49, kills: 280, deaths: 300 } };
const at = new Date("2026-08-03T12:00:00.000Z");

test("sector bar: one block per cap, and nothing at all for a scoreline that isn't caps", () => {
  assert.equal(sectorBar(2, 3), "🟦🟦🟥🟥🟥");
  assert.equal(sectorBar(5, 0), "🟦🟦🟦🟦🟦");
  // Blocks only — the scoreline is printed directly above the bar, so a "3 – 2" beside it repeats.
  assert.ok(!/\d/.test(sectorBar(2, 3)), "the bar does not restate the score");
  // Offensive and skirmish score differently — draw nothing rather than a bar that lies.
  assert.equal(sectorBar(0, 0), "");
  assert.equal(sectorBar(120, 340), "");
  assert.equal(sectorBar(undefined, undefined), "");
});

test("clock: hours appear only when there are hours, and nonsense reads as unknown", () => {
  assert.equal(clock(4548), "1:15:48");
  assert.equal(clock(75), "1:15");
  assert.equal(clock(undefined), "—");
  assert.equal(clock(-1), "—");
});

test("the embed carries the round: server name above, map as the headline, six compact fields", () => {
  const e = buildStatusEmbed({
    serverName: "The [LYNX] Division #1 | MIC'S MANDATORY!!", sides: SIDES, totals: TOTALS,
    vips: 10, nextMap: "CARENTAN", mapArt: "foy-day.webp",
    session: {
      mapName: "FOY", gameMode: "Warfare", alliedScore: 2, axisScore: 3,
      playerCount: 98, maxPlayerCount: 100, remainingMatchTime: 4548,
      queueCount: 4, maxQueueCount: 6, vipQueueCount: 2, maxVipQueueCount: 4,
    },
    at,
  });

  // The ROUND is the headline. A community name runs to three lines of shouting caps, so it sits
  // in the small author line rather than swallowing the top of the embed.
  assert.equal(e.title, "FOY · Warfare");
  assert.match(e.author.name, /LYNX. Division #1/);

  // Score and the ground it describes, above everything, in two short lines.
  assert.match(e.description ?? "", /\*\*Allies 2 – 3 Axis\*\*/);
  assert.match(e.description ?? "", /🟦🟦🟥🟥🟥/, "the sectors are drawn");

  // Six inline fields, two rows of three. Every value stays short so Discord lays them out as a
  // grid instead of giving up and stacking one per line.
  assert.equal(e.fields.length, 6);
  assert.ok(e.fields.every((f) => f.inline === true), "all six are inline");
  assert.deepEqual(e.fields.map((f) => f.name), ["Players", "Queue", "Time left", "🟦 Allies", "🟥 Axis", "Next map"]);
  for (const f of e.fields) {
    for (const line of f.value.split("\n")) assert.ok(line.length <= 24, `field ${f.name} line too wide: ${line}`);
  }

  assert.equal(e.fields[0]!.value, "98/100\n10 VIP");
  assert.equal(e.fields[1]!.value, "4/6\n2 VIP waiting");
  assert.equal(e.fields[2]!.value, "1:15:48");
  assert.equal(e.fields[3]!.value, "49 players\n300 k · 280 d");
  assert.equal(e.fields[4]!.value, "49 players\n280 k · 300 d");
  assert.equal(e.fields[5]!.value, "CARENTAN");

  // The map's artwork rides on the message itself, so no public URL is needed for it.
  assert.deepEqual(e.image, { url: "attachment://foy-day.webp" });
  // Axis lead, so the stripe is red.
  assert.equal(e.color, 0xef4444);
  assert.equal(e.timestamp, at.toISOString());
});

test("with no artwork for the map the embed simply has no picture", () => {
  const e = buildStatusEmbed({ serverName: "S", sides: SIDES, totals: TOTALS, vips: 0, session: { mapName: "FOY" }, at });
  assert.equal(e.image, undefined);
  assert.equal(e.title, "FOY");
  assert.equal(e.fields[5]!.value, "—", "an unknown next map is a dash, not a gap in the grid");
});

test("a VIP counter that cannot be a queue is left out, not printed as one", () => {
  // The live payload: 742 against a declared VIP queue maximum of 2, on a 100-slot server. The
  // board used to relay "742 in VIP queue" to Discord every minute.
  const e = buildStatusEmbed({
    serverName: "S", sides: SIDES, totals: TOTALS, vips: 29,
    session: {
      playerCount: 100, maxPlayerCount: 100,
      queueCount: 6, maxQueueCount: 6, vipQueueCount: 742, maxVipQueueCount: 2,
    },
    at,
  });
  const queue = e.fields.find((f) => f.name === "Queue")!.value;
  assert.ok(!/742/.test(queue), "the impossible count is not shown");
  assert.ok(!/waiting/.test(queue), "and it is not shown as a queue at all");
  assert.equal(queue, "6/6\n2 VIP slots", "the reserved slots are named for what they are");
  assert.equal(e.fields.find((f) => f.name === "Players")!.value, "100/100\n29 VIP");
});

test("a number the server never reported reads as unknown, not as zero", () => {
  const e = buildStatusEmbed({ serverName: "S", sides: SIDES, totals: {}, vips: 0, session: {}, at });
  assert.equal(e.fields.find((f) => f.name === "Players")!.value, "—/—\n0 VIP", "absent counts are not invented as 0");
  assert.equal(e.fields.find((f) => f.name === "Time left")!.value, "—");
  assert.equal(e.fields.find((f) => f.name === "Queue")!.value, "—", "no queue reported is not a queue of zero");
  assert.match(e.description ?? "", /Allies — – — Axis/);
  assert.equal(e.color, 0x6b7280, "no lead, no colour claim");
});

test("the embed stays inside Discord's limits, whatever the game and staff call things", () => {
  /**
   * Discord rejects the WHOLE message when an embed field is over its limit — so an over-long map
   * name does not truncate a line, it stops the board updating, with nothing on screen saying why.
   * A map's display name is typed by staff and its live name comes off the session, so neither is
   * this module's to trust.
   */
  const e = buildStatusEmbed({
    serverName: "S".repeat(400), sides: SIDES, totals: TOTALS, vips: 0,
    nextMap: "N".repeat(2000),
    session: { mapName: "M".repeat(500), gameMode: "Warfare", alliedScore: 1, axisScore: 1 },
    at: new Date("2026-08-22T12:00:00.000Z"),
  });
  assert.ok(e.title.length <= 256, `title is ${e.title.length} chars, past Discord's 256`);
  assert.ok((e.author?.name ?? "").length <= 256, "the author line was already sliced and stays so");
  for (const f of e.fields) {
    assert.ok(f.name.length <= 256, `field name "${f.name.slice(0, 20)}…" is ${f.name.length} chars`);
    assert.ok(f.value.length <= 1024, `field "${f.name}" is ${f.value.length} chars, past Discord's 1024`);
  }
});
