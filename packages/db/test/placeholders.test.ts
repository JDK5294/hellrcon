/**
 * The shared placeholder engine — the one every player-facing message goes through.
 *
 * Field incident: a group message with {player_name} and {vip_until} reached players with the
 * braces still in it. These pin the vocabulary, the VIP wording for each case a paying player can
 * be in, the leave-it-as-typed contract, and the batch reading the server's VIP list once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPlaceholders, messageRenderer, MESSAGE_PLACEHOLDERS, serverTimezone } from "../src/placeholders.ts";
import type { Repository } from "../src/types.ts";

const NOW = Date.parse("2026-09-26T12:00:00Z");

/** Only what the renderer reads, counting each read so batching is observable. */
function fakeRepo(vips: { playerId: string; expiration: string | null }[]) {
  const reads = { vips: 0, tz: 0, economy: 0, players: 0 };
  const repo = {
    autosettings: { getConfig: async () => { reads.tz++; return { timezone: "America/New_York" }; } },
    vips: { list: async () => { reads.vips++; return vips; } },
    economy: {
      config: async () => { reads.economy++; return { currencyName: "Lynx Bucks" }; },
      member: async (id: string) => (id === "discord-1" ? { balance: 420 } : null),
    },
    players: {
      findByPlatformIds: async (ids: string[]) => {
        reads.players++;
        return ids.includes("linked") ? [{ id: "rec-1", name: "Linked Larry" }] : [];
      },
    },
    externalLinks: { list: async (id: string) => (id === "rec-1" ? [{ provider: "discord", externalId: "discord-1" }] : []) },
  } as unknown as Repository;
  return { repo, reads };
}

test("only known tokens count, so an unrelated brace costs no reads", () => {
  assert.equal(hasPlaceholders("Hi {player_name}"), true);
  assert.equal(hasPlaceholders("Hi {PLAYER_NAME}"), true);
  assert.equal(hasPlaceholders("Killed by {attacker_name}"), false);
  assert.equal(hasPlaceholders("no tokens"), false);
  assert.equal(hasPlaceholders(null), false);
  assert.ok(MESSAGE_PLACEHOLDERS.some((p) => p.token === "vip_until" && p.scope === "player"));
});

test("a text with no tokens is returned untouched with no reads", async () => {
  const { repo, reads } = fakeRepo([]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  assert.equal(await r.render("plain text", { playerId: "p1" }), "plain text");
  assert.deepEqual(reads, { vips: 0, tz: 0, economy: 0, players: 0 });
});

test("the group-message incident: each player's own name and VIP, every VIP case", async () => {
  const { repo } = fakeRepo([
    { playerId: "dated", expiration: "2026-10-03T23:45:00Z" },
    { playerId: "perm", expiration: null },
    { playerId: "expired", expiration: "2026-09-01T00:00:00Z" },
  ]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  const msg = "Thanks {player_name}! VIP until {vip_until} ({vip_remaining} left).";
  assert.equal(await r.render(msg, { playerId: "dated", playerName: "Able" }),
    "Thanks Able! VIP until Oct 3, 7:45 PM EDT (7d 12h left).");
  assert.equal(await r.render(msg, { playerId: "perm", playerName: "Baker" }),
    "Thanks Baker! VIP until permanent (permanent left).");
  assert.equal(await r.render(msg, { playerId: "expired", playerName: "Charlie" }),
    "Thanks Charlie! VIP until no VIP (no VIP left).");
  assert.equal(await r.render(msg, { playerId: "none", playerName: "Dog" }),
    "Thanks Dog! VIP until no VIP (no VIP left).");
});

test("a whole batch reads the VIP list and timezone once", async () => {
  const { repo, reads } = fakeRepo([{ playerId: "a", expiration: "2026-10-03T23:45:00Z" }]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  for (const id of ["a", "b", "c", "d"]) await r.render("{vip_until}", { playerId: id, playerName: id });
  assert.equal(reads.vips, 1);
  assert.ok(reads.tz <= 1);
});

test("the name falls back to the player record, then the id", async () => {
  const { repo } = fakeRepo([]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  assert.equal(await r.render("{player_name}", { playerId: "linked" }), "Linked Larry");
  assert.equal(await r.render("{player_name}", { playerId: "7656119" }), "7656119");
});

test("balance and currency fill for a linked player; unlinked leaves {balance} as typed", async () => {
  const { repo } = fakeRepo([]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  assert.equal(await r.render("{balance} {currency}", { playerId: "linked" }), "420 Lynx Bucks");
  assert.equal(await r.render("{balance} {currency}", { playerId: "stranger" }), "{balance} Lynx Bucks");
});

test("server tokens fill from a live session; a server-wide text leaves player tokens as typed", async () => {
  const { repo } = fakeRepo([]);
  let sessions = 0;
  const r = messageRenderer(repo, {
    serverId: "s1", serverName: "[LYNX] WW2", nowMs: NOW,
    live: { session: async () => { sessions++; return { mapName: "Carentan", playerCount: 64 }; } },
  });
  assert.equal(await r.render("{server_name} on {map_name} with {player_count} — hi {player_name} {unknown}"),
    "[LYNX] WW2 on Carentan with 64 — hi {player_name} {unknown}");
  await r.render("{map_name}");
  assert.equal(sessions, 1, "the session is read once per batch");
});

test("without a session reader, {map_name} is left as typed rather than blanked", async () => {
  const { repo } = fakeRepo([]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  assert.equal(await r.render("Now on {map_name}"), "Now on {map_name}");
});

/*
 * The second set: {seed_count}, {playtime}, {players_needed}, {next_map}, and VIP on a named server
 * — which has to cross from WW2 to Vietnam, where the same person has a DIFFERENT id.
 */
const WW2 = { id: "ww2", name: "WW2", gameName: "[LYNX] Hell Let Loose", nickname: "WW2", publicName: null, publicSlug: null, game: "hll" };
const NAM = { id: "nam", name: "Vietnam", gameName: "[LYNX] Vietnam", nickname: "Vietnam", publicName: null, publicSlug: "nam", game: "hllv" };

function fullRepo(over: {
  vips?: Record<string, { playerId: string; expiration: string | null }[]>;
  audit?: { id: string; data: Record<string, unknown> }[];
  mapVoteCfg?: Record<string, unknown> | null;
  mapVoteState?: Record<string, unknown> | null;
} = {}) {
  const auditQueries: Record<string, unknown>[] = [];
  const repo = {
    autosettings: { getConfig: async () => ({ timezone: "UTC" }) },
    vips: { list: async (serverId: string) => over.vips?.[serverId] ?? [] },
    economy: { config: async () => null, member: async () => null },
    servers: { list: async () => [WW2, NAM] },
    players: {
      findByPlatformIds: async (ids: string[]) => ids.includes("steam-1") ? [{ id: "rec-ww2", game: "hll", platformId: "steam-1", name: "Able" }]
        : ids.includes("steam-2") ? [{ id: "rec-2", game: "hll", platformId: "steam-2", name: "Baker" }] : [],
    },
    externalLinks: {
      list: async (id: string) => (id === "rec-ww2" ? [{ provider: "discord", externalId: "d-1" }] : []),
      findPlayers: async (_p: string, ext: string) => ext === "d-1"
        ? [{ id: "rec-ww2", game: "hll", platformId: "steam-1" }, { id: "rec-nam", game: "hllv", platformId: "eos-1" }] : [],
    },
    stats: { visitsFor: async (ids: string[]) => new Map(ids.includes("rec-ww2") ? [["rec-ww2", { visits: 40, playtimeSec: 312 * 3600 + 1200 }]] : []) },
    seeding: { getConfig: async () => ({ seedTarget: 40 }) },
    mapNames: { list: async () => [{ mapId: "B_WARFARE", displayName: "Bravo (custom)" }] },
    mapVote: {
      getConfig: async () => over.mapVoteCfg ?? null,
      getState: async () => over.mapVoteState ?? null,
    },
    audit: {
      list: async (q: Record<string, unknown>) => { auditQueries.push(q); return (q.offset as number) > 0 ? [] : over.audit ?? []; },
    },
  } as unknown as Repository;
  return { repo, auditQueries };
}

test("{vip_until:<server>} crosses games through the Discord link — the WW2 player's Vietnam VIP", async () => {
  const { repo } = fullRepo({ vips: { nam: [{ playerId: "eos-1", expiration: null }], ww2: [{ playerId: "steam-1", expiration: "2026-10-03T23:45:00Z" }] } });
  const r = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW });
  assert.equal(await r.render("WW2 {vip_until:WW2} / Vietnam {vip_until:Vietnam}", { playerId: "steam-1" }),
    "WW2 Oct 3, 11:45 PM UTC / Vietnam permanent");
  // Any of the server's names, any case, and the game id when one server runs it.
  assert.equal(await r.render("{vip_until:nam} {vip_until:HLLV} {vip_remaining:vietnam}", { playerId: "steam-1" }), "permanent permanent permanent");
  // No Discord link → the other game's account is unknown: said plainly, never "no VIP".
  assert.equal(await r.render("{vip_until:Vietnam}", { playerId: "steam-2" }), "not linked");
  // A server name that matches nothing is a typo and stays visible.
  assert.equal(await r.render("{vip_until:Pacific}", { playerId: "steam-1" }), "{vip_until:Pacific}");
  assert.equal(hasPlaceholders("{vip_until:Vietnam}"), true);
  assert.equal(hasPlaceholders("{player_name:Vietnam}"), false, "only VIP tokens take a server");
});

test("{seed_count} counts distinct paid rounds — not dry-runs, failures, retries or bridge landings", async () => {
  const { repo, auditQueries } = fullRepo({
    audit: [
      { id: "a", data: { round: "r1" } },
      { id: "b", data: { round: "r1", retry: true } },   // a retry of r1 — still one seed
      { id: "c", data: { round: "r2" } },
      { id: "d", data: { round: "r3", dryRun: true } },
      { id: "e", data: { round: "r4", failed: "rcon down" } },
      { id: "f", data: { bridgeFrom: "nam", hours: 24 } }, // Vietnam's seed paid out here
      { id: "g", data: {} },                               // an old receipt from before rounds were stamped
    ],
  });
  const r = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW });
  assert.equal(await r.render("seed #{seed_count}", { playerId: "steam-1" }), "seed #3");
  assert.equal((auditQueries[0] as { serverId: string }).serverId, "ww2", "this server's seeds only");
  // In the reward message the round being paid counts before its receipt is written.
  const paying = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW, seedRound: "r9" });
  assert.equal(await paying.render("{seed_count}", { playerId: "steam-1" }), "4");
  const again = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW, seedRound: "r2" });
  assert.equal(await again.render("{seed_count}", { playerId: "steam-1" }), "3", "a retry of a counted round is not a new seed");
});

test("{playtime} is this server's total, in whole hours", async () => {
  const { repo } = fullRepo();
  const r = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW });
  assert.equal(await r.render("{playtime}", { playerId: "steam-1" }), "312h");
  assert.equal(await r.render("{playtime}", { playerId: "stranger" }), "0m");
});

test("{players_needed} counts down to the seed target, and stops at 0", async () => {
  const { repo } = fullRepo();
  const at = (n: number) => messageRenderer(repo, { serverId: "ww2", serverName: "WW2", nowMs: NOW, live: { session: async () => ({ playerCount: n }) } });
  assert.equal(await at(26).render("{players_needed} more!"), "14 more!");
  assert.equal(await at(55).render("{players_needed}"), "0");
  assert.equal(await messageRenderer(repo, { serverId: "ww2", serverName: "WW2" }).render("{players_needed}"), "{players_needed}", "no live read, no guess");
});

test("{next_map}: staff pick, else the open vote's leader, else the rotation", async () => {
  const label = (id: string) => `pretty(${id})`;
  const live = { session: async () => null, rotation: async () => ({ maps: ["a_warfare", "b_warfare", "c_warfare"], currentIndex: 2 }) };
  const vote = { enabled: true };
  const open = { activeMessageId: "m1", paused: false, options: [{ id: "x", name: "Foy — Warfare" }, { id: "y", name: "Hill 400 — Warfare" }], tallies: [2, 5], overrideMapId: null };
  const mk = (cfg: Record<string, unknown> | null, st: Record<string, unknown> | null) =>
    messageRenderer(fullRepo({ mapVoteCfg: cfg, mapVoteState: st }).repo, { serverId: "ww2", serverName: "WW2", live, mapLabel: label });
  assert.equal(await mk(vote, { ...open, overrideMapId: "stmereeglise_warfare" }).render("{next_map}"), "pretty(stmereeglise_warfare)");
  assert.equal(await mk(vote, open).render("{next_map}"), "Hill 400 — Warfare");
  assert.equal(await mk(vote, { ...open, paused: true }).render("{next_map}"), "pretty(a_warfare)", "a paused vote decides nothing");
  assert.equal(await mk(null, null).render("{next_map}"), "pretty(a_warfare)", "the rotation wraps around");
  // A map staff renamed is announced under that name, exactly as the vote announces it.
  const onB = messageRenderer(fullRepo().repo, { serverId: "ww2", serverName: "WW2", game: "hll", mapLabel: label,
    live: { session: async () => null, rotation: async () => ({ maps: ["a_warfare", "b_warfare"], currentIndex: 0 }) } });
  assert.equal(await onB.render("{next_map}"), "Bravo (custom)");
});

test("a message saved with a server's OLD name keeps working after a rename", async () => {
  const renamed = { ...WW2, id: "ww2", name: "WW2 #1", nickname: "WW2 #1", formerNames: ["WW2"] };
  // Another server now CALLED "WW2" would win: current names always beat former ones.
  const { repo } = fullRepo({ vips: { ww2: [{ playerId: "steam-1", expiration: null }] } });
  (repo as unknown as { servers: { list: () => Promise<unknown[]> } }).servers.list = async () => [renamed, { ...NAM, formerNames: [] }];
  const r = messageRenderer(repo, { serverId: "nam", serverName: "Vietnam", game: "hllv", nowMs: NOW });
  assert.equal(await r.render("{vip_until:WW2} / {vip_until:WW2 #1}", { playerId: "eos-x" }), "not linked / not linked",
    "both names resolve to the renamed server (this player just has no WW2 account)");
  const taken = { ...NAM, id: "other", name: "WW2", nickname: "WW2", formerNames: [] };
  (repo as unknown as { servers: { list: () => Promise<unknown[]> } }).servers.list = async () => [renamed, taken];
  const r2 = messageRenderer(repo, { serverId: "other", serverName: "WW2", game: "hllv", nowMs: NOW });
  assert.equal(await r2.render("{vip_until:WW2}", { playerId: "eos-x" }), "no VIP", "the server called WW2 now is the one meant");
});

test("a long in-game server name still works after the colon", async () => {
  const long = "[LYNX] Division | Hell Let Loose Vietnam | Newbie Friendly | discord.gg lynxdivision";
  const { repo } = fullRepo({ vips: { nam: [{ playerId: "eos-1", expiration: null }] } });
  (repo as unknown as { servers: { list: () => Promise<unknown[]> } }).servers.list = async () => [WW2, { ...NAM, name: long, nickname: null, gameName: long, formerNames: [] }];
  const r = messageRenderer(repo, { serverId: "ww2", serverName: "WW2", game: "hll", nowMs: NOW });
  assert.equal(await r.render(`{vip_until:${long}}`, { playerId: "steam-1" }), "permanent");
});

test("{constructor} and {__proto__} stay as typed — never JavaScript's internals", async () => {
  const { repo } = fakeRepo([]);
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  // A player can name themselves this; seeding substitutes the name before the renderer runs.
  assert.equal(await r.render("{constructor} {__proto__} on {server_name}", { playerId: "p" }), "{constructor} {__proto__} on WW2");
});

test("a paused VIP is never told they have no VIP — players pay for it", async () => {
  const pausedAt = "2026-09-20T12:00:00Z";
  const row = (over: Record<string, unknown>) => ({ playerId: "p", expiration: "2026-09-25T12:00:00Z", pausedAt, pausedUntil: null, pauseMode: "banked", ...over });
  const say = async (v: Record<string, unknown>) => {
    const { repo } = fakeRepo([row(v) as never]);
    return messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW }).render("{vip_until} | {vip_remaining}", { playerId: "p" });
  };
  // Banked: the meter froze on the 20th with 5 days left; the stored date has passed, the time has not.
  assert.equal(await say({}), "paused | 5d (paused)");
  // Running: the clock keeps going, so the date is real — marked paused.
  assert.equal(await say({ pauseMode: "running", expiration: "2026-10-03T23:45:00Z" }), "Oct 3, 7:45 PM EDT (paused) | 7d 12h (paused)");
  assert.equal(await say({ expiration: null }), "permanent (paused) | permanent (paused)");
  // A pause whose end has passed is over: plain wording again.
  assert.equal(await say({ pausedUntil: "2026-09-21T00:00:00Z", pauseMode: "running", expiration: "2026-10-03T23:45:00Z" }), "Oct 3, 7:45 PM EDT | 7d 12h");
});

test("grant-then-message batches: {vip_until:<this server>} reads each player's NEW time, like {vip_until}", async () => {
  const { InMemoryRepository, messageRenderer: distRenderer } = await import("../dist/index.js");
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "WW2", host: "h", port: 1, password: "x" });
  const r = distRenderer(repo, { serverId: server.id, serverName: "WW2", game: "hll", vipPerPlayer: true, nowMs: NOW });
  const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
  await repo.vips.upsert({ serverId: server.id, playerId: "a", expiration: inDays(1) } as never);
  await repo.vips.upsert({ serverId: server.id, playerId: "b", expiration: inDays(1) } as never);
  // The bulk grant: A gets their day, A is messaged; THEN B gets theirs, B is messaged.
  await repo.vips.upsert({ serverId: server.id, playerId: "a", expiration: inDays(2) } as never);
  assert.equal(await r.render("{vip_remaining:WW2}", { playerId: "a" }), "2d");
  await repo.vips.upsert({ serverId: server.id, playerId: "b", expiration: inDays(2) } as never);
  assert.equal(await r.render("{vip_remaining} / {vip_remaining:WW2}", { playerId: "b" }), "2d / 2d", "B's new time, not the list read before B's grant");
});

/*
 * A server whose Auto settings were never saved has no zone of its own, and {vip_until} read that
 * as UTC: players on the US east coast were told their VIP ends at 11:45 PM UTC instead of 7:45 PM
 * EDT. The community's zone (Settings) is what such a server runs on.
 */
test("a server with no zone of its own tells its players the community's time", async () => {
  const repo = {
    autosettings: { getConfig: async () => null },
    appConfig: { get: async () => ({ timezone: "America/New_York" }) },
    vips: { list: async () => [{ playerId: "dated", expiration: "2026-10-03T23:45:00Z" }] },
  } as unknown as Repository;
  const r = messageRenderer(repo, { serverId: "s1", serverName: "WW2", nowMs: NOW });
  assert.equal(await r.render("VIP until {vip_until}", { playerId: "dated" }), "VIP until Oct 3, 7:45 PM EDT");
});

test("the server's zone: its own Auto settings one first, then the community's, else none", async () => {
  const zones = (own: string | null | undefined, community: string | null) => ({
    autosettings: { getConfig: async () => (own === undefined ? null : { timezone: own }) },
    appConfig: { get: async () => ({ timezone: community }) },
  }) as unknown as Repository;
  assert.equal(await serverTimezone(zones("Europe/Berlin", "America/New_York"), "s1"), "Europe/Berlin", "its own");
  assert.equal(await serverTimezone(zones(undefined, "America/New_York"), "s1"), "America/New_York", "never set up: the community's");
  assert.equal(await serverTimezone(zones("", "America/New_York"), "s1"), "America/New_York", "a blank one: the community's");
  assert.equal(await serverTimezone(zones(undefined, null), "s1"), null, "neither");
  const broken = { autosettings: { getConfig: async () => { throw new Error("down"); } }, appConfig: { get: async () => { throw new Error("down"); } } } as unknown as Repository;
  assert.equal(await serverTimezone(broken, "s1"), null, "unreadable: the caller's own fallback");
});
