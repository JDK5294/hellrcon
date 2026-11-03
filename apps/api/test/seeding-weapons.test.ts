/**
 * The seeding weapon picker's self-updating half. The static catalogue (CRCON's weapon table)
 * goes stale the day the game patches; the server's own kill logs cannot. So the picker and its
 * exact-name validation take the UNION: catalogue names plus every weapon this server's match
 * rollups have recorded, verbatim. A game update's new or renamed weapons become pickable and
 * bannable on their own after their first kills land — no table edit, no release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

test("weapons seen in this server's logs join the picker and validate as restrictions", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const server = await repo.servers.create({ name: "S", host: "127.0.0.1", port: 61, password: "p" });
    const other = await repo.servers.create({ name: "T", host: "127.0.0.1", port: 62, password: "p" });
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000061", name: "Shooter" });

    // A finished round whose rollup carries a weapon the catalogue has never heard of — the
    // exact shape a game update's new gun arrives in.
    const match = await repo.matches.open({ serverId: server.id, map: "carentan_warfare", startedAt: "2026-09-20T10:00:00.000Z" });
    await repo.matches.close(match.id, { endedAt: "2026-09-20T11:00:00.000Z", winner: "allies", alliedScore: 3, axisScore: 2, result: null });
    await repo.matches.saveWeaponRollup(match.id, [
      { playerId: player.id, weapon: "M1941 JOHNSON", classId: "other", kills: 3, deaths: 0 },
      // A name the catalogue already knows must NOT appear twice.
      { playerId: player.id, weapon: "M1 GARAND", classId: "rifle", kills: 5, deaths: 1 },
    ]);

    const got = await jf(`${base}/api/servers/${server.id}/seeding`, { headers: auth });
    assert.equal(got.status, 200);
    const weapons = got.body.weapons as { name: string; classId: string; fromLogs?: boolean }[];
    const johnson = weapons.find((w) => w.name === "M1941 JOHNSON");
    assert.ok(johnson, "the log-seen weapon is in the picker");
    assert.equal(johnson?.fromLogs, true, "and marked as harvested from the logs, not the catalogue");
    assert.equal(weapons.filter((w) => w.name.toUpperCase() === "M1 GARAND").length, 1, "a catalogue name never doubles");

    // Exact-name restrictions: the log-seen name is now valid; a never-seen guess still is not.
    const ok = await jf(`${base}/api/servers/${server.id}/seeding`, {
      method: "PUT", headers: auth, body: JSON.stringify({ disallowedWeaponNames: ["M1941 JOHNSON"] }),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const bad = await jf(`${base}/api/servers/${server.id}/seeding`, {
      method: "PUT", headers: auth, body: JSON.stringify({ disallowedWeaponNames: ["TOTALLY MADE UP GUN"] }),
    });
    assert.equal(bad.status, 400, "free-typed guesses are still refused");

    // The harvest is PER SERVER: a sibling that never saw the weapon does not offer it.
    const sibling = await jf(`${base}/api/servers/${other.id}/seeding`, { headers: auth });
    assert.ok(!(sibling.body.weapons as { name: string }[]).some((w) => w.name === "M1941 JOHNSON"),
      "another server's logs do not leak into this picker");
  });
});
