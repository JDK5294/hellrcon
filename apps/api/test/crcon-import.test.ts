import { test } from "node:test";
import assert from "node:assert/strict";
import { mapVips, mapBans, mapBlacklists, mapBlacklistRecords, inferPlatform, normExpiry, watchInfoOf } from "../src/crcon-import.ts";

test("mapVips: extracts id/name/expiry across shapes and key aliases", () => {
  // bare array with modern keys
  const a = mapVips([
    { player_id: "76561198000000001", name: "Alpha", vip_expiration: "2030-01-02T03:04:05Z" },
    { steam_id_64: "76561198000000002", player_name: "Bravo", expiration: "never" },
    { name: "no-id" }, // dropped: no player id
  ]);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { playerId: "76561198000000001", playerName: "Alpha", expiration: "2030-01-02T03:04:05.000Z" });
  assert.equal(a[1]!.expiration, null); // "never" → permanent

  // wrapped shape { vips: [...] } — a bare `id` only counts when it LOOKS like a game id. CRCON
  // puts its own small database ids in `id`, and accepting one would mint a phantom player profile
  // ("duplicate person") keyed on a number that means nothing in game.
  const b = mapVips({ vips: [
    { id: "111", name: "Wrapped-internal-id" }, // dropped: that's CRCON's row id, not a person
    { id: "bd867e5778d6dda93187f20e7623cb4c", name: "Wrapped-real-id" },
  ] });
  assert.equal(b.length, 1);
  assert.equal(b[0]!.playerId, "bd867e5778d6dda93187f20e7623cb4c");
});

test("mapBans: perma has no expiry, temp keeps it, reason defaults", () => {
  const bans = mapBans({ bans: [
    { type: "perma", player_id: "1", name: "Cheater", reason: "aimbot" },
    { ban_type: "temp", steam_id_64: "2", expires_at: "2031-05-06T00:00:00Z" },
    { player_id: "3" }, // no reason → default
  ] });
  assert.equal(bans.length, 3);
  assert.equal(bans[0]!.expiresAt, null);
  assert.equal(bans[0]!.reason, "aimbot");
  assert.equal(bans[1]!.expiresAt, "2031-05-06T00:00:00.000Z");
  assert.equal(bans[2]!.reason, "Imported from CRCON");
});

test("mapBans / mapBlacklistRecords: the record's OWN moment comes along, never the import's", () => {
  // CRCON stores UTC; vanilla-ban parses use ban_time, blacklist rows created_at, both often naive.
  const bans = mapBans({ bans: [
    { type: "perma", player_id: "1", reason: "aimbot", ban_time: "2023-04-05T12:00:00" },
    { type: "temp", player_id: "2", timestamp: 1680696000 }, // unix seconds
    { type: "perma", player_id: "3" }, // no stamp at all → null, NOT "now"
  ] });
  assert.equal(bans[0]!.at, "2023-04-05T12:00:00.000Z");
  assert.equal(bans[1]!.at, "2023-04-05T12:00:00.000Z");
  assert.equal(bans[2]!.at, null);
  const recs = mapBlacklistRecords({ records: [{ player_id: "4", reason: "tk", created_at: "2022-11-01T09:30:00Z" }] });
  assert.equal(recs[0]!.at, "2022-11-01T09:30:00.000Z");
});

test("normExpiry: iso passthrough, permanent words → null, junk → null", () => {
  assert.equal(normExpiry("2030-01-01T00:00:00Z"), "2030-01-01T00:00:00.000Z");
  assert.equal(normExpiry("never"), null);
  assert.equal(normExpiry("permanent"), null);
  assert.equal(normExpiry(""), null);
  assert.equal(normExpiry("not-a-date"), null);
});

test("mapBlacklists: pulls id/name across shapes, names default", () => {
  const a = mapBlacklists([{ id: 1, name: "Cheaters" }, { blacklist_id: "2" }, { name: "no-id" }]);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { id: "1", name: "Cheaters" });
  assert.equal(a[1]!.name, "blacklist 2"); // default name from id
  const b = mapBlacklists({ blacklists: [{ id: "9", name: "Wrapped" }] });
  assert.equal(b[0]!.id, "9");
});

test("mapBlacklistRecords: unwraps nested result/records and reads nested player", () => {
  // bare array
  const a = mapBlacklistRecords([{ player_id: "1", reason: "toxic", expires_at: "2031-01-01T00:00:00Z" }]);
  assert.equal(a[0]!.reason, "toxic");
  assert.equal(a[0]!.expiresAt, "2031-01-01T00:00:00.000Z");
  // { records: [...] } with nested player
  const b = mapBlacklistRecords({ records: [{ player: { player_id: "2", name: "Nested" }, admin_name: "AdminJoe" }] });
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], { playerId: "2", playerName: "Nested", reason: "Imported from CRCON", expiresAt: null, author: "AdminJoe", at: null });
  // { result: { records: [...] } }
  const c = mapBlacklistRecords({ result: { records: [{ player_id: "3", reason: "spam" }] } });
  assert.equal(c[0]!.playerId, "3");
});

test("watchInfoOf: the CRCON watch object's reason, author and time come along", () => {
  // Profile rows nest the watch under `watchlist`; CRCON serializes UTC without a zone suffix.
  const nested = watchInfoOf({ player_id: "1", name: "Griefer", watchlist: { is_watched: true, reason: "repeat TK", by: "OldAdmin", modified: "2024-05-01T10:00:00" } });
  assert.deepEqual(nested, { watched: true, reason: "repeat TK", by: "OldAdmin", at: "2024-05-01T10:00:00.000Z" });

  // Archive `watchlist` records ARE the watch row (no nesting), with a zoned timestamp.
  const flat = watchInfoOf({ steam_id_64: "3", is_watched: true, reason: "hacking?", by: "Mod2", modified: "2023-11-02T08:30:00+02:00" });
  assert.deepEqual(flat, { watched: true, reason: "hacking?", by: "Mod2", at: "2023-11-02T06:30:00.000Z" });

  // A bare watch object with no flag still means watched; missing details stay null.
  assert.deepEqual(watchInfoOf({ watchlist: { reason: "salty" } }), { watched: true, reason: "salty", by: null, at: null });
  assert.equal(watchInfoOf({ name: "nobody" }).watched, null);
});

test("inferPlatform: 17-digit id → steam, else other", () => {
  assert.equal(inferPlatform("76561198000000001"), "steam");
  assert.equal(inferPlatform("abc-123"), "other");
});

test("mappers tolerate empty / non-array payloads", () => {
  assert.deepEqual(mapVips(null), []);
  assert.deepEqual(mapVips({}), []);
  assert.deepEqual(mapBans("nope"), []);
  assert.deepEqual(mapBlacklists(null), []);
  assert.deepEqual(mapBlacklistRecords(undefined), []);
});
