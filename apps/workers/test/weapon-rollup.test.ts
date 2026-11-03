/**
 * The weapon fold behind the public records, both directions: kills WITH a weapon credit the
 * killer, deaths TO it debit the victim, off the same events. Teamkills stay out of both sides
 * (a TK death is deathsByTk on the round pages, not a relationship with a weapon), classes come
 * from the game's OWN classifier — proven for both games.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepWeaponRollups, weaponKillRollup } from "../src/weapon-rollup.ts";
import { classifyWeapon, getGame } from "@app/games";

const kill = (actor: string | null, victim: string | null, weapon: string | null, kind = "evt.kill") =>
  ({ kind, actorPlayerId: actor, victimPlayerId: victim, weapon });

test("weaponKillRollup counts kills and deaths per player per weapon, classed by the game", () => {
  const descriptor = getGame("hll")?.descriptor;
  const classify = (w: string) => classifyWeapon(descriptor, w);
  const rows = weaponKillRollup([
    kill("ana", "bob", "MG42"),
    kill("ana", "cid", "MG42"),
    kill("ana", "bob", "M1 GARAND"),
    kill("bob", "ana", "155MM HOWITZER [M114]"),
    kill("ana", "bob", "MG42", "evt.teamkill"),  // a TK counts on neither side
    kill(null, "bob", "MG42"),                    // no killer: the death still counts
    kill("ana", null, "MG42"),                    // no victim resolved: the kill still counts
  ], classify);
  const by = new Map(rows.map((r) => [`${r.playerId}|${r.weapon}`, r]));
  assert.deepEqual(by.get("ana|MG42"), { playerId: "ana", weapon: "MG42", classId: "mg", kills: 3, deaths: 0 });
  assert.deepEqual(by.get("bob|MG42"), { playerId: "bob", weapon: "MG42", classId: "mg", kills: 0, deaths: 2 });
  assert.deepEqual(by.get("ana|155MM HOWITZER [M114]"), { playerId: "ana", weapon: "155MM HOWITZER [M114]", classId: "artillery", kills: 0, deaths: 1 });
  assert.equal(by.get("bob|M1 GARAND")?.deaths, 1);
  assert.equal(rows.reduce((n, r) => n + r.kills, 0), 5, "teamkills stay out of the kill side");
  assert.equal(rows.reduce((n, r) => n + r.deaths, 0), 5, "and out of the death side");
});

test("the same fold speaks Vietnam: mortars, helicopters and the M60 land in Vietnam's own classes", () => {
  const descriptor = getGame("hllv")?.descriptor;
  const classify = (w: string) => classifyWeapon(descriptor, w);
  const rows = weaponKillRollup([
    kill("cuu", "gia", "82MM MORTAR"),
    kill("cuu", "gia", "M60D [UH-1 IROQUOIS]"),
    kill("dao", "cuu", "M60"),
    kill("dao", "cuu", "M16A1"),
  ], classify);
  const by = new Map(rows.filter((r) => r.kills > 0).map((r) => [r.weapon, r.classId]));
  assert.equal(by.get("82MM MORTAR"), "mortar", "Vietnam's mortar class, which WW2 does not have");
  assert.equal(by.get("M60D [UH-1 IROQUOIS]"), "helicopter", "the door gun belongs to the airframe");
  assert.equal(by.get("M60"), "mg");
  assert.equal(by.get("M16A1"), "rifle");
  const gia = rows.filter((r) => r.playerId === "gia");
  assert.equal(gia.reduce((n, r) => n + r.deaths, 0), 2, "the victim side rides the same rows");
});

/*
 * The sweep around the fold. A round that cannot be saved is the interesting case: it must cost
 * only itself. The batch is newest-first, so a poison round at the head that aborted the loop
 * would park every older round behind it forever — the backfill would simply stop.
 */
const stubRepo = (matches: { id: string; serverId: string; game: string | null }[], failOn: string[]) => {
  const saved: string[] = [];
  return {
    saved,
    repo: {
      matches: {
        pendingWeaponRollup: async () => matches.map((m) => ({ ...m, startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T10:40:00.000Z" })),
        saveWeaponRollup: async (matchId: string) => {
          if (failOn.includes(matchId)) throw new Error("write failed");
          saved.push(matchId);
        },
      },
      servers: { list: async () => [{ id: "s1", game: "hll" }] },
      events: {
        window: async ({ serverId }: { serverId: string }) => (serverId === "unreadable"
          ? Promise.reject(new Error("read failed"))
          : [{ kind: "evt.kill", actorPlayerId: "ana", victimPlayerId: "bob", weapon: "MG42" }]),
      },
    },
  };
};
const classifyFor = (game: string) => (w: string) => classifyWeapon(getGame(game)?.descriptor, w);

test("a round that will not save costs only itself — the rest of the batch still rolls up", async () => {
  const { repo, saved } = stubRepo([
    { id: "poison", serverId: "s1", game: "hll" },
    { id: "m2", serverId: "s1", game: "hll" },
    { id: "m3", serverId: "s1", game: "hllv" },
  ], ["poison"]);
  await sweepWeaponRollups(repo, 20, classifyFor);
  assert.deepEqual(saved, ["m2", "m3"], "the failure is skipped, not fatal — and it stays unstamped for the next sweep");
});

test("a round whose events cannot be read stamps nothing and blocks nobody", async () => {
  const { repo, saved } = stubRepo([
    { id: "m1", serverId: "unreadable", game: "hll" },
    { id: "m2", serverId: "s1", game: null },
  ], []);
  await sweepWeaponRollups(repo, 20, classifyFor);
  assert.deepEqual(saved, ["m2"], "the unreadable round is left for later; the server's own game covers the null");
});
