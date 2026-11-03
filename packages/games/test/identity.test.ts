import { test } from "node:test";
import assert from "node:assert/strict";
// Imported from dist (test script builds first) — same pattern as the other games tests.
import { playerIdentityOf, registerGame, getGame, HLL_GAME } from "../dist/index.js";
import type { GameModule } from "../dist/types.js";

/**
 * Which of a roster payload's fields is the durable player identity is a per-game decision, and
 * getting it wrong forks one human into twin database rows. These tests pin BOTH sides of the
 * contract: the default that HLL relies on today, and the override pattern the HLL: Vietnam
 * module will need (key on the reported Steam64 when there is one, because that is the id the
 * player already exists under from the HLL servers; fall back to the per-game EOS id only when
 * there is nothing better).
 */

test("default identity: the reported id is the platform id, and eosId rides along as a link", () => {
  const who = playerIdentityOf(HLL_GAME, { iD: "76561198000000001", platform: "steam", eosId: "abc123" });
  assert.deepEqual(who, {
    platform: "steam",
    platformId: "76561198000000001",
    links: [{ provider: "eos", externalId: "abc123" }],
  });
});

test("default identity: no eosId means no links, and lowercase `id` works too", () => {
  const who = playerIdentityOf(HLL_GAME, { id: " 76561198000000002 ", platform: "steam" });
  assert.deepEqual(who, { platform: "steam", platformId: "76561198000000002" });
});

test("default identity: a payload with no id at all is null, never an empty-string row", () => {
  assert.equal(playerIdentityOf(HLL_GAME, { name: "ghost" }), null);
  assert.equal(playerIdentityOf(undefined, {}), null);
});

test("default identity: a missing platform degrades to 'unknown', not to a broken row", () => {
  const who = playerIdentityOf(undefined, { iD: "x1" });
  assert.deepEqual(who, { platform: "unknown", platformId: "x1" });
});

test("a module's identity hook overrides the default — the HLL: Vietnam pattern", () => {
  // A stand-in for the future HLL:V module: the game reports its own per-game EOS id as `id`
  // and the Steam64 alongside for Steam players. Keying on the Steam64 keeps that human the
  // SAME person as their HLL profile; the EOS id becomes a link, so it stays searchable.
  const vietnamLike: GameModule = {
    ...HLL_GAME,
    id: "test-hllv-identity",
    identity: (pl) => {
      const eos = String(pl?.id ?? "").trim();
      if (!eos) return null;
      const steam = String(pl?.steamId ?? "").trim();
      return steam
        ? { platform: "steam", platformId: steam, links: [{ provider: "eos", externalId: eos }] }
        : { platform: "eos", platformId: eos };
    },
  };
  registerGame(vietnamLike);
  const mod = getGame("test-hllv-identity");

  // Steam player: keyed on the Steam64 — the same row their HLL play already created.
  assert.deepEqual(playerIdentityOf(mod, { id: "00021a2b3c4d", steamId: "76561198000000003", platform: "steam" }), {
    platform: "steam",
    platformId: "76561198000000003",
    links: [{ provider: "eos", externalId: "00021a2b3c4d" }],
  });

  // Console player: nothing bridges the games, so the EOS id IS the identity — a second profile,
  // honestly, until staff merge it by hand (which is what player merge exists for).
  assert.deepEqual(playerIdentityOf(mod, { id: "00025e6f7890", platform: "psn" }), {
    platform: "eos",
    platformId: "00025e6f7890",
  });
});

test("rosterPlayerId: the first NON-EMPTY spelling — an empty iD never hides the real id", async () => {
  const { rosterPlayerId } = await import("../dist/index.js");
  assert.equal(rosterPlayerId({ iD: "", id: "76561198000000001" }), "76561198000000001");
  assert.equal(rosterPlayerId({ Id: " abc " }), "abc");
  assert.equal(rosterPlayerId({ ID: "x", iD: "y" }), "y", "iD first when it has a value");
  assert.equal(rosterPlayerId({ name: "nobody" }), "");
  assert.equal(rosterPlayerId(null), "");
});
