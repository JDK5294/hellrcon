import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, askedFor } from "./harness.ts";
import { parsePoolConfig } from "../dist/routes/kit.js";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "m", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("map display name: set, then clear (blank), with audit", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const set = await jf(`${base}/api/servers/${id}/maps/carentan_warfare/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "The Bocage" }) });
    assert.equal(set.status, 200);
    assert.equal(set.body.custom, true);
    assert.equal(set.body.displayName, "The Bocage");

    // blank clears → falls back to the inferred name, custom=false
    const clear = await jf(`${base}/api/servers/${id}/maps/carentan_warfare/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "  " }) });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.custom, false);
    assert.match(clear.body.displayName, /Carentan/);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "map.name"));

    // A display name is not confined to the panel: it rides into the Discord status board's
    // "Next map" field and the in-game vote announcement, both of which reject the whole message
    // when a limit is passed. It was the one name in the app with no bound at all.
    const tooLong = await jf(`${base}/api/servers/${id}/maps/carentan_warfare/name`, {
      method: "PUT", headers: auth, body: JSON.stringify({ displayName: "x".repeat(201) }),
    });
    assert.equal(tooLong.status, 400);
    assert.match(String(tooLong.body.error?.message ?? ""), /too long/i);
    // …and the rename that was already there is untouched by the refusal.
    const still = await jf(`${base}/api/servers/${id}/maps`, { headers: auth });
    assert.ok(JSON.stringify(still.body).length > 0);
  });
});

test("map name override is game-scoped: applies across servers of the same game", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const a = await makeServer(base, auth);
    const created2 = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "m2", host: "127.0.0.1", port: 2, password: "x" }) });
    const b = created2.body.server.id as string;
    await jf(`${base}/api/servers/${a}/maps/foy_warfare/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "Winter Line" }) });
    // setting via server B (same game) reports the same override already present when re-set identically
    const viaB = await jf(`${base}/api/servers/${b}/maps/foy_warfare/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "Winter Line" }) });
    assert.equal(viaB.body.custom, true);
    assert.equal(viaB.body.displayName, "Winter Line");
  });
});

test("renaming requires server.config; blank mapId path segments 404", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/servers/${id}/maps/foy_warfare/name`, { method: "PUT", body: JSON.stringify({ displayName: "x" }) })).status, 401);
    // Lacking the permission no longer refuses a server-scoped write: it files it for somebody
    // who holds it (202, nothing renamed yet). See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/maps/foy_warfare/name`, { method: "PUT", headers: plain, body: JSON.stringify({ displayName: "x" }) })).status, 202);
    assert.equal((await jf(`${base}/api/servers/nope/maps/foy_warfare/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "x" }) })).status, 404);
  });
});

test("map-vote pairings: PUT stores links, GET resolves them against the library", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // empty by default
    const empty = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.profiles, []);
    assert.deepEqual(empty.body.profileLinks, []);
    assert.equal(empty.body.activeProfile, null);
    // The starter library ships with the config, so the editor's dropdowns are never empty.
    assert.ok((empty.body.sets as any[]).some((x) => x.name === "dday"));
    assert.ok((empty.body.schedules as any[]).length > 0);

    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "America/New_York",
      profiles: [
        { mapSet: "dday", schedule: "D-Day (6 June)" },
        { mapSet: "default", schedule: null }, // no schedule → always applies (last)
      ],
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.timezone, "America/New_York");
    assert.equal(put.body.profileLinks.length, 2);

    // The combined surface and the duplicate protection round-trip like any other setting —
    // and an untouched config answers them off (registered-only defaults false, surface native).
    assert.equal(put.body.surface ?? "native", "native");
    assert.equal(put.body.registeredOnlyIngame ?? false, false);
    assert.equal(put.body.registeredOnlyDiscord ?? false, false);
    // The RETIRED single flag still reads as "both gates on" — a parked draft or old client that
    // had the protection must not lose it — while the split fields are the real interface.
    const both = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      surface: "both", registeredOnly: true,
      // The same pairings as above, so the resolution assertions below keep describing this PUT.
      profiles: [
        { mapSet: "dday", schedule: "D-Day (6 June)" },
        { mapSet: "default", schedule: null },
      ],
    }) });
    assert.equal(both.status, 200);

    const get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(get.body.surface, "both");
    assert.equal(get.body.registeredOnlyIngame, true, "the legacy flag lands on both gates");
    assert.equal(get.body.registeredOnlyDiscord, true);

    // The split posture round-trips: open Discord, registered-only in game.
    const split = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      surface: "both", registeredOnlyIngame: true, registeredOnlyDiscord: false,
      profiles: [
        { mapSet: "dday", schedule: "D-Day (6 June)" },
        { mapSet: "default", schedule: null },
      ],
    }) });
    assert.equal(split.status, 200);
    assert.equal(split.body.registeredOnlyIngame, true);
    assert.equal(split.body.registeredOnlyDiscord, false);
    // conditionless "default" is last → it's the active set on any non-D-Day date
    assert.equal(get.body.activeProfile, "default");
    // The stored pairing is resolved into a whole profile for the engine: the set's maps and the
    // schedule's window arrive together even though they are two separate records.
    assert.equal(get.body.profiles[0].name, "dday");
    assert.deepEqual(get.body.profiles[0].spec.dates, ["06-06"]);
    assert.ok(get.body.profiles[0].pool.allowedMaps.length > 0, "the library set's maps came through");

    // A pairing naming something that does not exist fails LOUDLY here rather than silently
    // resolving to nothing and letting the engine offer the whole catalogue at vote time.
    const ghost = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [{ mapSet: "no such set" }],
    }) });
    assert.equal(ghost.status, 400);
    assert.match(ghost.body.error.message, /no map set called/);
    const ghostSched = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [{ mapSet: "default", schedule: "never" }],
    }) });
    assert.equal(ghostSched.status, 400);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "mapvote.config"));
  });
});

/*
 * The library is the point of the change: one set, usable everywhere, and every starter row an
 * ordinary record. This covers the parts that are easy to get silently wrong — a rename has to
 * carry the servers pointing at it, and a delete must not be allowed to quietly widen a vote.
 */
test("map-set library: a retired server's pairing is named, and said to be retired, never shown as a bare id", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const live = (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "live ww2", host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const old = (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "old ww2", host: "127.0.0.1", port: 2, password: "x" }) })).body.server.id as string;
    const made = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({ name: "retired-pairing", game: "hll", pool: { dayCount: 4 } }) });
    assert.equal(made.status, 201);
    for (const id of [live, old]) {
      const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [{ mapSet: "retired-pairing" }] }) });
      assert.equal(put.status, 200);
    }
    assert.equal((await jf(`${base}/api/servers/${old}/retire`, { method: "POST", headers: auth })).status, 200);

    const listed = await jf(`${base}/api/servers/${live}/mapvote/config`, { headers: auth });
    const set = (listed.body.sets as any[]).find((x) => x.name === "retired-pairing");
    assert.deepEqual([...set.usedBy].sort(), ["live ww2", "old ww2 (retired)"], "the editor's \"used by\" names it");

    // Still counted: the pairing resolves again the day the server comes back, so it still holds the set.
    const refused = await jf(`${base}/api/mapvote/sets/${made.body.set.id}`, { method: "DELETE", headers: auth });
    assert.equal(refused.status, 409);
    const message = String(refused.body.error.message);
    assert.match(message, /still in use on/);
    assert.ok(message.includes("old ww2 (retired)") && message.includes("live ww2"), `the refusal names both: ${message}`);
    assert.ok(!message.includes(old), "never by its bare id");
  });
});

test("map-set library: shared across servers, renames follow, in-use records cannot be deleted", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const a = await makeServer(base, auth);
    const bCreated = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "second", host: "127.0.0.1", port: 2, password: "x" }) });
    const b = bCreated.body.server.id as string;

    const made = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "weeknights", game: "hll", pool: { dayCount: 4 },
    }) });
    assert.equal(made.status, 201);
    const setId = made.body.set.id as string;

    const sched = await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "evenings", spec: { start: "18:00", end: "22:00" },
    }) });
    assert.equal(sched.status, 201);

    // The same set on BOTH servers — one record, two users of it. That is the whole feature.
    for (const id of [a, b]) {
      const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
        profiles: [{ mapSet: "weeknights", schedule: "evenings" }],
      }) });
      assert.equal(put.status, 200);
      assert.equal(put.body.profiles[0].pool.dayCount, 4);
    }

    // Editing it once changes both, with no per-server copy to keep in step.
    await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({ pool: { dayCount: 6 } }) });
    for (const id of [a, b]) {
      const cfg = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
      assert.equal(cfg.body.profiles[0].pool.dayCount, 6, "both servers saw the edit");
    }

    // "used by" rides along so nobody edits a shared record blind.
    const listed = await jf(`${base}/api/servers/${a}/mapvote/config`, { headers: auth });
    const weeknights = (listed.body.sets as any[]).find((x) => x.name === "weeknights");
    assert.equal(weeknights.usedBy.length, 2);

    // A rename carries every pairing with it — otherwise both servers would silently stop
    // resolving and fall back to the engine's whole-catalogue defaults.
    await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "midweek" }) });
    for (const id of [a, b]) {
      const cfg = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
      assert.equal(cfg.body.profileLinks[0].mapSet, "midweek");
      assert.equal(cfg.body.profiles.length, 1, "still resolves after the rename");
    }

    // Deleting something a server still points at is refused, and says where.
    const refused = await jf(`${base}/api/mapvote/sets/${setId}`, { method: "DELETE", headers: auth });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /still in use/);

    // Drop it from both and the delete goes through — the starter rows are just as deletable.
    for (const id of [a, b]) {
      await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [] }) });
    }
    assert.equal((await jf(`${base}/api/mapvote/sets/${setId}`, { method: "DELETE", headers: auth })).status, 200);

    // Names are unique case-insensitively, since a pairing resolves by name.
    const dup = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({ name: "DDAY", game: "hll" }) });
    assert.equal(dup.status, 409);

    // A schedule is validated on its own route now that it is its own record.
    assert.equal((await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "junk", spec: { start: "25:00" } }) })).status, 400);
    assert.equal((await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "junk", spec: { daysOfWeek: ["funday"] } }) })).status, 400);
    assert.equal((await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "junk", spec: { dates: ["6-6"] } }) })).status, 400);
    assert.equal((await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "junk", spec: { months: [13] } }) })).status, 400);
  });
});

test("map-vote vote-loop settings round-trip + validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, surface: "native", channelId: "500000000000000001", pollHours: 3, profiles: [{ mapSet: "default" }],
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.enabled, true);
    assert.equal(put.body.channelId, "500000000000000001");
    assert.equal(put.body.pollHours, 3);
    const get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(get.body.enabled, true);
    assert.equal(get.body.surface, "native");
    // validation
    const bad = (body: unknown) => jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await bad({ channelId: "not-a-snowflake", profiles: [] })).status, 400);
    assert.equal((await bad({ pollHours: 0, profiles: [] })).status, 400);
    assert.equal((await bad({ pollHours: 9999, profiles: [] })).status, 400);
  });
});

test("map-vote reminders round-trip + validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      reminders: [{ minutesAfterMatchStart: 10, message: "Vote on Discord {options}" }], profiles: [],
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.reminders.length, 1);
    assert.equal(put.body.reminders[0].minutesAfterMatchStart, 10);
    // A reminder written before layouts existed keeps working, and reads back as "message only".
    assert.equal(put.body.reminders[0].layout, "none");
    const bad = (r: unknown) => jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ reminders: r, profiles: [] }) });
    assert.equal((await bad([{ minutesAfterMatchStart: -1, message: "x" }])).status, 400);
    assert.equal((await bad([{ minutesAfterMatchStart: 5 }])).status, 400); // no message
    assert.equal((await bad([{ minutesAfterMatchStart: 5, message: "x", layout: "interpretive_dance" }])).status, 400);

    const withLayout = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      reminders: [{ minutesAfterMatchStart: 5, message: "Vote!", layout: "vote_counts" }], profiles: [],
    }) });
    assert.equal(withLayout.body.reminders[0].layout, "vote_counts");
  });
});

test("map-vote behaviour settings round-trip with sensible defaults + bounds", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Untouched config gets the recommended behaviour, not zeroes.
    const fresh = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(fresh.body.liveApply, true);
    assert.equal(fresh.body.postMatchApplyDelaySeconds, 300);
    assert.equal(fresh.body.pollResetDelaySeconds, 180);
    assert.equal(fresh.body.pauseBelowPlayers, 0);

    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [], liveApply: false, postMatchApplyDelaySeconds: 0, pollResetDelaySeconds: 45, pauseBelowPlayers: 4,
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.liveApply, false);
    assert.equal(put.body.pollResetDelaySeconds, 45);
    assert.equal(put.body.pauseBelowPlayers, 4);
    const get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(get.body.liveApply, false);
    assert.equal(get.body.pauseBelowPlayers, 4);

    const bad = (b: Record<string, unknown>) => jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [], ...b }) });
    assert.equal((await bad({ pollResetDelaySeconds: -1 })).status, 400);
    assert.equal((await bad({ postMatchApplyDelaySeconds: 99999 })).status, 400);
    assert.equal((await bad({ pauseBelowPlayers: 500 })).status, 400);
  });
});

test("a player's map votes: staff with map-vote access on one server see that server's ballots only", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string, port: number) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const a = await mk("votes-a", 11);
    const b = await mk("votes-b", 12);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "steam-4242", name: "Two Server Voter" });
    await repo.externalLinks.set(player.id, "discord", "4242", "test");
    const vote = (serverId: string, mapId: string) => repo.mapVote.recordHistory({
      serverId, profile: "default",
      options: [{ id: mapId, name: mapId, votes: 1, voters: [{ discordId: "4242", name: "two" }] }],
      winnerId: mapId, winnerName: mapId, totalVotes: 1, outcome: "vote", applied: true,
    });
    await vote(a, "foy_warfare");
    await vote(b, "carentan_warfare");

    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "votes-a-only", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [
        { capability: "mapvote.config", level: "read", scopeType: "server", scopeId: a },
        { capability: "server.view", level: "read", scopeType: "server", scopeId: a },
      ] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "votes-a-only", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };

    const mine = await jf(`${base}/api/players/${player.id}/mapvote`, { headers: scoped });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.totals.votes, 1, "only the ballot cast on the server they may see");
    assert.deepEqual(mine.body.ballots.map((x: any) => x.serverId), [a]);
    assert.deepEqual(mine.body.preferences.map((x: any) => x.mapId), ["foy_warfare"]);
    assert.equal((await jf(`${base}/api/players/${player.id}/mapvote?serverId=${b}`, { headers: scoped })).status, 403, "and the other server cannot be asked for by name");
    const owner = await jf(`${base}/api/players/${player.id}/mapvote`, { headers: auth });
    assert.equal(owner.body.totals.votes, 2, "someone who sees every server still sees both");
  });
});

test("map-vote ballots: who voted becomes per-voter and per-player analytics", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // A player whose Discord account is linked — the bridge from a snowflake to a person.
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "steam-77", name: "Voter One" });
    await repo.externalLinks.set(player.id, "discord", "111", "test");

    await repo.mapVote.recordHistory({
      serverId: id, profile: "default",
      options: [
        { id: "foy_warfare", name: "Foy", votes: 2, voters: [{ discordId: "111", name: "voter-one" }, { discordId: "222", name: "voter-two" }] },
        { id: "carentan_warfare", name: "Carentan", votes: 1, voters: [{ discordId: "333", name: "voter-three" }] },
      ],
      winnerId: "foy_warfare", winnerName: "Foy", totalVotes: 3, outcome: "vote", applied: true,
    });
    await repo.mapVote.recordHistory({
      serverId: id, profile: "default",
      options: [
        { id: "foy_warfare", name: "Foy", votes: 1, voters: [{ discordId: "111", name: "voter-one" }] },
        { id: "omaha_warfare", name: "Omaha Beach", votes: 1, voters: [{ discordId: "222", name: "voter-two" }] },
      ],
      winnerId: "omaha_warfare", winnerName: "Omaha Beach", totalVotes: 2, outcome: "vote", applied: true,
    });

    // The server view: who votes, how often, and how often they get their way. The rounds are
    // paged and the summary spans the WHOLE record, not the page.
    const hist = await jf(`${base}/api/servers/${id}/mapvote/history`, { headers: auth });
    assert.equal(hist.body.canSeeVoters, true);
    assert.equal(hist.body.total, 2, "total counts every recorded vote");
    assert.equal(hist.body.summary.rounds, 2);
    assert.equal(hist.body.summary.decided, 2);
    assert.equal(hist.body.summary.totalVotes, 5);
    const page2 = await jf(`${base}/api/servers/${id}/mapvote/history?limit=25&offset=1`, { headers: auth });
    assert.equal((page2.body.history as any[]).length, 1, "offset pages the rounds");
    assert.equal(page2.body.summary.rounds, 2, "the summary still describes the whole record");
    const voters = hist.body.voters as any[];
    assert.equal(voters.length, 3);
    const one = voters.find((v) => v.discordUserId === "111");
    assert.equal(one.votes, 2);
    assert.equal(one.wins, 1);          // Foy won once, Foy lost once
    assert.equal(one.playerId, player.id); // resolved through the Discord link
    assert.equal(one.playerName, "Voter One");
    assert.equal(voters.find((v) => v.discordUserId === "333").playerId, null); // no link, still counted
    // The ballot rides along inside the history options too. Selected by content: both votes are
    // recorded in the same millisecond, so their order in the list is not something to assert on.
    const withCarentan = (hist.body.history as any[]).find((h) => h.options.some((o: any) => o.id === "carentan_warfare"));
    const foyOption = withCarentan.options.find((o: any) => o.id === "foy_warfare");
    assert.deepEqual(foyOption.voters.map((v: any) => v.discordId).sort(), ["111", "222"]);

    // The player view: their record, reached by internal id or platform id.
    for (const key of [player.id, "steam-77"]) {
      const mine = await jf(`${base}/api/players/${key}/mapvote`, { headers: auth });
      assert.equal(mine.status, 200);
      assert.equal(mine.body.linked, true);
      assert.equal(mine.body.discordId, "111");
      assert.equal(mine.body.totals.votes, 2);
      assert.equal(mine.body.totals.wins, 1);
      assert.deepEqual(mine.body.preferences.map((p: any) => [p.mapId, p.votes]), [["foy_warfare", 2]]);
      assert.equal(mine.body.ballots.length, 2);
    }

    // A player with no linked Discord account says so, rather than looking like someone who never votes.
    const stranger = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "steam-99", name: "Nobody" });
    const none = await jf(`${base}/api/players/${stranger.id}/mapvote`, { headers: auth });
    assert.equal(none.body.linked, false);
    assert.equal(none.body.totals.votes, 0);

    // Recording the same poll twice must not double-count anybody.
    const again = await repo.mapVote.recordHistory({
      serverId: id, profile: "default",
      options: [{ id: "foy_warfare", name: "Foy", votes: 1, voters: [{ discordId: "111", name: "voter-one" }] }],
      winnerId: "foy_warfare", winnerName: "Foy", totalVotes: 1, outcome: "vote", applied: true,
    });
    assert.ok(again.id);
    assert.equal((await repo.mapVote.voterTotals("111")).votes, 3); // 2 + the new one, not 4

    // Map-vote access is what gates the ballot — no separate analytics permission on top.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "cfgonly", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [
        { capability: "mapvote.config", level: "read", scopeType: "global", scopeId: null },
        { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      ] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "cfgonly", password: "pw" }) });
    const limited = { authorization: `Bearer ${l.body.token as string}` };
    const seen = await jf(`${base}/api/servers/${id}/mapvote/history`, { headers: limited });
    assert.equal(seen.status, 200);
    assert.equal((seen.body.voters as any[]).length, 3);
    assert.ok((seen.body.history as any[]).flatMap((h) => h.options).some((o: any) => (o.voters ?? []).length > 0));
    assert.equal((await jf(`${base}/api/players/${player.id}/mapvote`, { headers: limited })).status, 200);

    // Without map-vote access it stays shut, even for someone who can see the player.
    const v = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "viewonly", password: "pw" }) });
    await jf(`${base}/api/users/${v.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [{ capability: "server.view", level: "read", scopeType: "global", scopeId: null }] }),
    });
    const l2 = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "viewonly", password: "pw" }) });
    const viewer = { authorization: `Bearer ${l2.body.token as string}` };
    const denied = await jf(`${base}/api/players/${player.id}/mapvote`, { headers: viewer });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.missing?.capability, "mapvote.config");
  });
});

test("map-vote start / resync / announce are requests the worker picks up", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const st = () => jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });

    // Park the vote in the worst state staff can find it in: paused, with a map forced.
    await jf(`${base}/api/servers/${id}/mapvote/pause`, { method: "POST", headers: auth, body: JSON.stringify({ paused: true }) });
    await jf(`${base}/api/servers/${id}/mapvote/override`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare" }) });
    assert.equal((await st()).body.state.pauseReason, "staff");

    // "Start a new vote" is the one button that always gets things moving again.
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/start`, { method: "POST", headers: auth })).status, 200);
    let s = (await st()).body.state;
    assert.equal(s.startNow, true);
    assert.equal(s.paused, false);
    assert.equal(s.pauseReason, null);
    assert.equal(s.overrideMapId, null);

    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/resync`, { method: "POST", headers: auth })).status, 200);
    s = (await st()).body.state;
    assert.equal(s.resyncNow, true);
    assert.equal(s.startNow, true);

    // Announcing needs a vote to announce — otherwise there is nothing to say.
    const noVote = await jf(`${base}/api/servers/${id}/mapvote/announce`, { method: "POST", headers: auth, body: JSON.stringify({ layout: "vote_counts" }) });
    assert.equal(noVote.status, 409);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    const actions = (audit.body.entries as any[]).map((e) => e.action);
    assert.ok(actions.includes("mapvote.start"));
    assert.ok(actions.includes("mapvote.resync"));

    // authz: these change what players see, so they need write on mapvote.config.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    // …which now means "this becomes a request", not "you cannot": 202 with nothing done yet.
    for (const path of ["start", "resync", "announce"]) {
      const asked = await jf(`${base}/api/servers/${id}/mapvote/${path}`, { method: "POST", headers: plain, body: "{}" });
      assert.equal(asked.status, 202, `${path}: ${JSON.stringify(asked.body)}`);
      assert.equal(asked.body.requested, true);
    }
  });
});

test("map-vote pause + override controls (state, audit, authz)", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/pause`, { method: "POST", headers: auth, body: JSON.stringify({ paused: true }) })).body.paused, true);
    let get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(get.body.state.paused, true);

    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/override`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare" }) })).body.overrideMapId, "carentan_warfare");
    get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(get.body.state.overrideMapId, "carentan_warfare");
    // blank clears
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/override`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "" }) })).body.overrideMapId, null);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "mapvote.pause"));
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "mapvote.override"));

    // authz
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const askedPause = await jf(`${base}/api/servers/${id}/mapvote/pause`, { method: "POST", headers: plain, body: JSON.stringify({ paused: true }) });
    assert.equal(askedPause.status, 202, JSON.stringify(askedPause.body));
    assert.equal(askedPause.body.label, "Pause or resume the map vote", "and it says in words what it would do");
  });
});

test("map-vote config validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ timezone: "Not/AZone", profiles: [] })).status, 400);
    assert.equal((await put({ profiles: [{ schedule: "Daytime" }] })).status, 400); // no set named
    // The spec itself is validated on the schedule route now that a schedule is its own record.
    // requires server.config
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: plain })).status, 403);
  });
});

test("map reads require auth + a known server (before any RCON)", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    assert.equal((await jf(`${base}/api/servers/whatever/maps`)).status, 401);
    assert.equal((await jf(`${base}/api/servers/nope/maps`, { headers: auth })).status, 404);
    // set-next validates the body + observe/unknown before connecting
    assert.equal((await jf(`${base}/api/servers/nope/maps/next`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "x" }) })).status, 404);
    // poll preview: auth + known-server guards run before any RCON connection
    assert.equal((await jf(`${base}/api/servers/whatever/maps/poll/preview`, { method: "POST", body: JSON.stringify({}) })).status, 401);
    assert.equal((await jf(`${base}/api/servers/nope/maps/poll/preview`, { method: "POST", headers: auth, body: JSON.stringify({ config: { dayCount: 3 } }) })).status, 404);
  });
});

test("map vote: live tally, skip/reroll requests, and recorded history", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "mv", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // a poll is open with counts parked by the worker
    await repo.mapVote.setState({
      serverId: id, activeMessageId: "m1", activeChannelId: "c1",
      options: [{ id: "foy_warfare", name: "Foy" }, { id: "carentan_warfare", name: "Carentan" }],
      profile: "default", openedAt: new Date().toISOString(), lastMatchEndAt: null,
      paused: false, pauseReason: null, pauseNoticeId: null, savedOptions: [], overrideMapId: null, recentMaps: [],
      tallies: [3, 5], talliedAt: new Date().toISOString(), lastClosedMessageId: null, lastClosedChannelId: null,
      skipNext: false, reroll: false, startNow: false, resyncNow: false, sendMessageLayout: null,
      liveAppliedMapId: null, liveApplyNote: null, ingameVoters: null, reopenAt: null, manualHoldUntil: null, lastOpenError: null,
      updatedAt: new Date().toISOString(),
    });

    const cfg = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(cfg.body.state.activePoll.totalVotes, 8);
    assert.deepEqual(cfg.body.state.activePoll.options.map((o: any) => [o.id, o.votes]), [["foy_warfare", 3], ["carentan_warfare", 5]]);

    // Why the leader is not queued has to reach the panel. Without it, a vote whose leader is never
    // applied reads exactly like a working one: "Next map: whatever the rotation says", no reason.
    assert.equal(cfg.body.state.liveApplyNote, null);
    await repo.mapVote.patchState(id, { liveApplyNote: "settling after the last match (240s left)" });
    const noted = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(noted.body.state.liveApplyNote, "settling after the last match (240s left)");

    // skip + reroll are recorded as requests for the worker, not applied by the API
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/skip`, { method: "POST", headers: auth, body: JSON.stringify({ skip: true }) })).body.skipNext, true);
    assert.equal((await repo.mapVote.getState(id))?.skipNext, true);
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/reroll`, { method: "POST", headers: auth })).body.reroll, true);
    assert.equal((await repo.mapVote.getState(id))?.reroll, true);

    // history + per-map tallies
    await repo.mapVote.recordHistory({
      serverId: id, profile: "default",
      options: [{ id: "foy_warfare", name: "Foy", votes: 3 }, { id: "carentan_warfare", name: "Carentan", votes: 5 }],
      winnerId: "carentan_warfare", winnerName: "Carentan", totalVotes: 8, outcome: "vote", applied: true,
    });
    await repo.mapVote.recordHistory({
      serverId: id, profile: "default",
      options: [{ id: "foy_warfare", name: "Foy", votes: 1 }],
      winnerId: "foy_warfare", winnerName: "Foy", totalVotes: 1, outcome: "vote", applied: true,
    });

    const hist = await jf(`${base}/api/servers/${id}/mapvote/history`, { headers: auth });
    assert.equal(hist.body.history.length, 2);
    const foy = hist.body.tally.find((t: any) => t.mapId === "foy_warfare");
    assert.equal(foy.offered, 2, "offered in both votes");
    assert.equal(foy.won, 1, "won one of them");
    assert.equal(foy.votes, 4, "3 + 1 votes across both");

    // reading history needs the map-vote permission
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "nomv", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "nomv", password: "pw" }) });
    const weak = { authorization: `Bearer ${l.body.token as string}` };
    void u;
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/history`, { headers: weak })).status, 403);
  });
});

test("map vote: variety + variant preference survive a save (and reject junk)", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "var", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const made = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "p", game: "hll", pool: { variety: "per-map-mode", variantPreference: "prefer-day", dayCount: 2 },
    }) });
    assert.equal(made.status, 201);
    const setId = made.body.set.id as string;
    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: false, timezone: "UTC", profiles: [{ mapSet: "p" }],
    }) });
    assert.equal(put.status, 200);

    const cfg = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    const pool = cfg.body.profiles[0].pool;
    assert.equal(pool.variety, "per-map-mode", "variety persisted");
    assert.equal(pool.variantPreference, "prefer-day", "variant preference persisted");
    void repo;

    // an unknown variety falls back to the safe default rather than reaching the engine
    await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({
      pool: { variety: "nonsense", variantPreference: "nonsense" },
    }) });
    const after = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(after.body.profiles[0].pool.variety, "per-map");
    assert.equal(after.body.profiles[0].pool.variantPreference, "random");

    // The poll size is the vote surface's limit, not a preference: Discord refuses the whole
    // message when handed an eleventh answer, so a stored 20 is not a bigger vote, it is no vote.
    // Clamped on the way in, where staff can still see what was saved.
    await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({
      pool: { maxOptions: 20 },
    }) });
    const capped = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(capped.body.profiles[0].pool.maxOptions, 10, "maxOptions above the surface limit was stored as-is");

    // …and a smaller poll is still allowed to be small.
    await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({
      pool: { maxOptions: 4 },
    }) });
    const small = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(small.body.profiles[0].pool.maxOptions, 4);
  });
});

test("console admins: auth + capability + unknown server, all before any RCON", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // No token / no capability / unknown server are all refused before a connection is attempted.
    assert.equal((await jf(`${base}/api/servers/${id}/admins`)).status, 401);
    assert.equal((await jf(`${base}/api/servers/nope/admins`, { headers: auth })).status, 404);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainadm", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plainadm", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const denied = await jf(`${base}/api/servers/${id}/admins`, { headers: plain });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.missing?.capability, "server.admins");
    // A write without the capability is asked of someone who holds it — filed, not tried: the
    // stored list below is still empty, and no connection was made for it.
    const adminsHere = { capability: "server.admins", serverId: id };
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: plain, body: "{}" })), adminsHere);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/servers/${id}/admins/xyz`, { method: "DELETE", headers: plain })), adminsHere);

    // Input validation happens before any grant is attempted.
    assert.equal((await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: auth, body: JSON.stringify({ group: "senior" }) })).status, 400); // no playerId
    assert.equal((await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "x" }) })).status, 400); // no group
    assert.equal((await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "x", group: "senior", mode: "until" }) })).status, 400); // until needs a date
    assert.equal((await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "x", group: "senior", mode: "duration", days: 0, hours: 0 }) })).status, 400);

    // Writes need the game; with the server unreachable nothing is applied → 409, and no row is stored.
    assert.equal((await jf(`${base}/api/servers/${id}/admins`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "x", group: "senior" }) })).status, 409);
    assert.equal((await jf(`${base}/api/servers/${id}/admins/xyz`, { method: "DELETE", headers: auth })).status, 409);

    // The list is OUR stored book of record — readable even though the game is unreachable, with
    // the stock groups offered as a fallback so the add form stays usable.
    const list = await jf(`${base}/api/servers/${id}/admins`, { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.admins, []);
    assert.ok(Array.isArray(list.body.groups) && list.body.groups.includes("senior"));
  });
});

test("console admins repo: expiry tracked like VIP — permanent vs timed, sweep query, creator kept", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await repo.consoleAdmins.upsert({ serverId: id, playerId: "perm", adminGroup: "senior", expiration: null, createdByName: "owner" });
    await repo.consoleAdmins.upsert({ serverId: id, playerId: "soon", adminGroup: "junior", expiration: past, createdByName: "owner" });
    await repo.consoleAdmins.upsert({ serverId: id, playerId: "later", adminGroup: "spectator", expiration: future, createdByName: "owner" });

    assert.equal((await repo.consoleAdmins.list(id)).length, 3);
    const expired = await repo.consoleAdmins.expired(new Date().toISOString());
    assert.deepEqual(expired.map((a) => a.playerId), ["soon"]); // permanent + future excluded

    // upsert keeps the original creator, refreshes group + expiration
    const updated = await repo.consoleAdmins.upsert({ serverId: id, playerId: "soon", adminGroup: "senior", expiration: future, createdByName: "someone-else" });
    assert.equal(updated.createdByName, "owner");
    assert.equal(updated.adminGroup, "senior");
    assert.equal(updated.expiration, future);
    assert.equal((await repo.consoleAdmins.expired(new Date().toISOString())).length, 0);

    // ...and the stored rows are exactly what GET serves.
    const list = await jf(`${base}/api/servers/${id}/admins`, { headers: auth });
    assert.equal(list.body.count, 3);
    assert.deepEqual((list.body.admins as { playerId: string }[]).map((a) => a.playerId).sort(), ["later", "perm", "soon"]);

    assert.equal(await repo.consoleAdmins.remove(id, "perm"), true);
    assert.equal((await repo.consoleAdmins.list(id)).length, 2);
  });
});

test("map-vote startup state: round-trips, defaults to remember, rejects anything else", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // A server that has never been configured reads as "remember" — the do-nothing posture, so the
    // field arriving in an existing deployment changes no behaviour until someone picks otherwise.
    const empty = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
    assert.equal(empty.body.startupState, "remember");

    // A client that predates the field must not silently acquire an opinion about restarts.
    const omitted = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, channelId: "500000000000000001", profiles: [{ mapSet: "default" }],
    }) });
    assert.equal(omitted.status, 200);
    assert.equal(omitted.body.startupState, "remember");

    for (const want of ["paused", "active", "remember"]) {
      const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
        enabled: true, channelId: "500000000000000001", profiles: [{ mapSet: "default" }], startupState: want,
      }) });
      assert.equal(put.status, 200, `${want} is accepted`);
      assert.equal(put.body.startupState, want, `${want} comes back from the PUT`);
      const get = await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth });
      assert.equal(get.body.startupState, want, `${want} survives a re-read`);
    }

    const bad = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [], startupState: "halted",
    }) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /startupState/);
  });
});

/*
 * Coverage must describe BOTH axes the schedule turns on. Sets are matched first-wins on time AND
 * player count, so a reading taken at one count ("133 hours uncovered at 60 players") is false at
 * every other count. The route returns exact regions cut at the bounds the config itself names.
 */
test("map-vote coverage: exact regions across time and player count, gaps named on both axes", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Sets and schedules are library records, so the fixture builds them once and the config
    // below is only the ordering. "seeding" is already a starter set; the rest are made here.
    const mk = async (path: string, body: unknown) =>
      assert.equal((await jf(`${base}/api/mapvote/${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).status, 201);
    await mk("sets", { name: "prime", game: "hll", pool: { dayCount: 4 } });
    await mk("schedules", { name: "under 40", spec: { playersBelow: 40 } });
    await mk("schedules", { name: "prime time", spec: { start: "18:00", end: "22:00" } });

    await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "UTC",
      profiles: [
        // Seeding: under 40 players, any time. Prime time: 18:00-22:00, any count.
        { mapSet: "seeding", schedule: "under 40" },
        { mapSet: "prime", schedule: "prime time" },
      ],
    }) });

    const r = await jf(`${base}/api/servers/${id}/mapvote/coverage`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.timezone, "UTC");
    assert.equal(r.body.hasGaps, true);

    // No day rules, so the whole week is one group.
    assert.equal((r.body.groups as any[]).length, 1);
    const bands = r.body.groups[0].bands as any[];
    assert.deepEqual(r.body.groups[0].days, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

    // Under 40, seeding wins every hour — prime time never gets a look in at that count.
    assert.deepEqual([bands[0].minPlayers, bands[0].maxPlayers], [0, 40]);
    assert.deepEqual(bands[0].spans, [{ startMinute: 0, endMinute: 1440, profile: "seeding" }]);

    // At 40+, only the evening is covered and the rest of the day matches nothing at all.
    assert.deepEqual([bands[1].minPlayers, bands[1].maxPlayers], [40, null]);
    assert.deepEqual(bands[1].spans, [
      { startMinute: 0, endMinute: 1080, profile: null },
      { startMinute: 1080, endMinute: 1320, profile: "prime" },
      { startMinute: 1320, endMinute: 1440, profile: null },
    ]);

    // A catch-all with no conditions closes every region, on both axes.
    await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "UTC",
      profiles: [
        { mapSet: "seeding", schedule: "under 40" },
        { mapSet: "prime", schedule: "prime time" },
        { mapSet: "default", schedule: null },
      ],
    }) });
    const closed = await jf(`${base}/api/servers/${id}/mapvote/coverage`, { headers: auth });
    assert.equal(closed.body.hasGaps, false);

    // A date-gated set is reported separately rather than drawn onto a normal week.
    await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "UTC",
      profiles: [
        { mapSet: "dday", schedule: "D-Day (6 June)" },
        { mapSet: "default", schedule: null },
      ],
    }) });
    const cal = await jf(`${base}/api/servers/${id}/mapvote/coverage`, { headers: auth });
    assert.deepEqual(cal.body.calendarOnly, [{ name: "dday", when: "06-06" }]);
    assert.equal(cal.body.hasGaps, false);
    assert.deepEqual(cal.body.groups[0].bands[0].spans, [{ startMinute: 0, endMinute: 1440, profile: "default" }]);

    // Gated like the rest of the vote config.
    assert.equal((await jf(`${base}/api/servers/${id}/mapvote/coverage`)).status, 401);
  });
});

/*
 * The family is what the vote engine calls "the same map" — it drives one-option-per-map and
 * resting every variant after one plays. It used to come only from rules reading the map id, with
 * a hardcoded exception list for the ids those rules get wrong, so every new map release was a
 * code change. As data, a stray is a couple of clicks on the catalogue page.
 */
test("map family: override, read back on the catalogue, and reset to the inferred one", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const set = await jf(`${base}/api/servers/${id}/maps/stmariedumont_off_us/family`, { method: "PUT", headers: auth, body: JSON.stringify({ family: "Sainte Marie" }) });
    assert.equal(set.status, 200);
    assert.equal(set.body.family, "sainte marie", "stored lower-cased so it groups regardless of typing");
    assert.equal(set.body.customFamily, true);
    assert.ok(set.body.defaultFamily, "the inferred one is reported so the editor can offer a reset");

    // Both overrides live on one row and neither clears the other.
    await jf(`${base}/api/servers/${id}/maps/stmariedumont_off_us/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "SMDM Offensive" }) });
    const stillFamily = await jf(`${base}/api/servers/${id}/maps/stmariedumont_off_us/family`, { method: "PUT", headers: auth, body: JSON.stringify({ family: "sainte marie" }) });
    assert.equal(stillFamily.body.family, "sainte marie");

    // Clearing the family leaves the display name alone…
    const cleared = await jf(`${base}/api/servers/${id}/maps/stmariedumont_off_us/family`, { method: "PUT", headers: auth, body: JSON.stringify({ family: "  " }) });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.customFamily, false);
    assert.equal(cleared.body.family, cleared.body.defaultFamily, "back to what the id implies");
    const name = await jf(`${base}/api/servers/${id}/maps/stmariedumont_off_us/name`, { method: "PUT", headers: auth, body: JSON.stringify({ displayName: "SMDM Offensive" }) });
    assert.equal(name.body.custom, true, "the name override survived the family being cleared");

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "map.family"));

    // Gated, and bounded.
    assert.equal((await jf(`${base}/api/servers/${id}/maps/foy_warfare/family`, { method: "PUT", body: JSON.stringify({ family: "x" }) })).status, 401);
    const long = await jf(`${base}/api/servers/${id}/maps/foy_warfare/family`, { method: "PUT", headers: auth, body: JSON.stringify({ family: "x".repeat(65) }) });
    assert.equal(long.status, 400);
  });
});

/*
 * Changing the map NOW is a different action from queueing one: it ends the round in progress
 * rather than rewriting the rotation, and it is the one the catalogue page offers. The command has
 * been in the descriptor since it was written (ChangeMap on binary-v2) — it just had nothing
 * calling it, so this pins the route's shape, its gating, and that observe mode refuses.
 */
test("change map now: gated, refused in observe mode, validated, and audited", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Signed out is a 401 before anything reaches the game.
    assert.equal((await jf(`${base}/api/servers/${id}/maps/change`, { method: "POST", body: JSON.stringify({ mapId: "foy_warfare" }) })).status, 401);

    // A fresh server is in observe mode, and this is a write: it must be refused there, not
    // attempted and failed — observe means the panel never touches the game.
    const observed = await jf(`${base}/api/servers/${id}/maps/change`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "foy_warfare" }) });
    assert.equal(observed.status, 409);
    assert.match(String(observed.body.error?.message ?? ""), /observe mode/i);

    // Missing map id is a 400, ahead of the connection attempt.
    await jf(`${base}/api/servers/${id}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "active" }) });
    const blank = await jf(`${base}/api/servers/${id}/maps/change`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "  " }) });
    assert.equal(blank.status, 400);

    // With a real map id it gets as far as the game, which is not reachable from a test — a 502
    // upstream, never a 500, and never a silent success.
    const tried = await jf(`${base}/api/servers/${id}/maps/change`, { method: "POST", headers: auth, body: JSON.stringify({ mapId: "foy_warfare" }) });
    assert.equal(tried.status, 502);
    assert.match(String(tried.body.error?.message ?? ""), /could not change the map/i);
  });
});

/*
 * A map set is a list of MAP IDS, and map ids belong to one game. The library stays shared across
 * servers — that was always the point — but only across servers of the same game. Pairing a WW2 set
 * to a Vietnam server would compose a poll of maps that server does not have: every option
 * unpickable, and nothing wrong to see until players are looking at the ballot in Discord.
 */
test("map sets belong to a game: the library is filtered and a cross-game pairing is refused", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const ww2 = await makeServer(base, auth);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "nam", host: "127.0.0.1", port: 9, password: "x", game: "hllv" }) });
    assert.equal(created.status, 201);
    const nam = created.body.server.id as string;
    assert.equal(created.body.server.game, "hllv");

    // A set has to say which game it is for — guessing is what made a Vietnam server read as WW2.
    const guessed = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({ name: "unstated" }) });
    assert.equal(guessed.status, 400);
    assert.match(guessed.body.error.message, /which game/);
    const bogus = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({ name: "bogus", game: "quake" }) });
    assert.equal(bogus.status, 400);

    const namSet = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "delta", game: "hllv", pool: { modeBuckets: [] },
    }) });
    assert.equal(namSet.status, 201);
    assert.equal(namSet.body.set.game, "hllv");

    // Each server's editor is offered only its own game's sets — the starter library is WW2, so the
    // Vietnam server never sees it, and the WW2 server never sees "delta".
    const ww2Lib = await jf(`${base}/api/servers/${ww2}/mapvote/config`, { headers: auth });
    const namLib = await jf(`${base}/api/servers/${nam}/mapvote/config`, { headers: auth });
    assert.ok((ww2Lib.body.sets as any[]).some((s) => s.name === "dday"), "WW2 keeps the starter library");
    assert.ok(!(ww2Lib.body.sets as any[]).some((s) => s.name === "delta"));
    assert.ok((namLib.body.sets as any[]).every((s) => s.game === "hllv"), "Vietnam sees only Vietnam sets");
    assert.ok((namLib.body.sets as any[]).some((s) => s.name === "delta"));
    // Schedules are times, not maps — they stay shared across every game.
    assert.ok((namLib.body.schedules as any[]).length > 0);

    // The guard is on the write, not only on what the editor happens to show.
    const crossed = await jf(`${base}/api/servers/${nam}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [{ mapSet: "dday" }],
    }) });
    assert.equal(crossed.status, 400);
    assert.match(crossed.body.error.message, /hll map set/);
    const other = await jf(`${base}/api/servers/${ww2}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [{ mapSet: "delta" }],
    }) });
    assert.equal(other.status, 400);

    // Its own game's set pairs normally.
    assert.equal((await jf(`${base}/api/servers/${nam}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      profiles: [{ mapSet: "delta" }],
    }) })).status, 200);

    // A set built before the second game existed can be relabelled — but not while a server is
    // pointing at it, since that pairing is exactly the cross-game one this rule forbids.
    const setId = namSet.body.set.id as string;
    const stuck = await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({ game: "hll" }) });
    assert.equal(stuck.status, 409);
    await jf(`${base}/api/servers/${nam}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [] }) });
    const moved = await jf(`${base}/api/mapvote/sets/${setId}`, { method: "PUT", headers: auth, body: JSON.stringify({ game: "hll" }) });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.set.game, "hll");
    assert.equal((await repo.mapSets.get(setId))!.game, "hll");
  });
});

/*
 * "Which set is in charge" on the vote screen must be judged on the clock AND the player count, as
 * the vote is. It read the clock alone, so a server whose every set is count-gated ("under 50" /
 * "50+") showed "none matched" while its vote ran on the right set.
 */
test("map-vote status: the set in charge is judged at the latest player count, and says when the count is unknown", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const mk = async (path: string, body: unknown) =>
      assert.equal((await jf(`${base}/api/mapvote/${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).status, 201);
    await mk("sets", { name: "Normal", game: "hll", pool: { dayCount: 4 } });
    await mk("schedules", { name: "under 50", spec: { playersBelow: 50 } });
    await mk("schedules", { name: "50 plus", spec: { playersAbove: 49 } });
    await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      timezone: "America/New_York",
      profiles: [{ mapSet: "seeding", schedule: "under 50" }, { mapSet: "Normal", schedule: "50 plus" }],
    }) });
    const read = async () => (await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth })).body;

    // No roster reading yet: nothing can match, and it says why.
    const unknown = await read();
    assert.equal(unknown.activeProfile, null);
    assert.equal(unknown.activeProfileNeedsCount, true);

    const snap = async (playerCount: number, minsAgo: number) => repo.rosterSnapshots.record({
      serverId: id, ts: new Date(Date.now() - minsAgo * 60_000).toISOString(), playerCount,
      composition: { players: playerCount, unassigned: 0, byRole: {}, bySide: {} },
    } as never);
    await snap(99, 1);
    const full = await read();
    assert.equal(full.activeProfile, "Normal");
    assert.equal(full.activeProfileCount, 99);
    assert.equal(full.activeProfileNeedsCount, false);

    await snap(20, 0.5);
    assert.equal((await read()).activeProfile, "seeding");
  });
});

test("map-vote status: a reading older than five minutes is not a reading of now", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/mapvote/schedules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "busy", spec: { playersAbove: 49 } }) });
    await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [{ mapSet: "seeding", schedule: "busy" }] }) });
    await repo.rosterSnapshots.record({ serverId: id, ts: new Date(Date.now() - 20 * 60_000).toISOString(), playerCount: 90, composition: { players: 90, unassigned: 0, byRole: {}, bySide: {} } } as never);
    const r = (await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth })).body;
    assert.equal(r.activeProfile, null);
    assert.equal(r.activeProfileCount, null);
    assert.equal(r.activeProfileNeedsCount, true);
  });
});

test("map set: always-offered maps survive a save — trimmed, one entry per map, never more than a poll holds", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const asked = ["carentan_warfare", "CARENTAN_WARFARE", " foy_warfare ", "", ...Array.from({ length: 11 }, (_, i) => `map${i}_warfare`)];
    const made = await jf(`${base}/api/mapvote/sets`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "always", game: "hll", pool: { dayCount: 2, alwaysOffer: asked },
    }) });
    assert.equal(made.status, 201);
    const put = await jf(`${base}/api/servers/${id}/mapvote/config`, { method: "PUT", headers: auth, body: JSON.stringify({ profiles: [{ mapSet: "always" }] }) });
    assert.equal(put.status, 200);
    const pool = (await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth })).body.profiles[0].pool;
    assert.equal(pool.alwaysOffer.length, 10, "no more than one poll holds");
    assert.deepEqual(pool.alwaysOffer.slice(0, 3), ["carentan_warfare", "foy_warfare", "map0_warfare"], "trimmed, blanks gone, one entry per map");

    // The editor saves the whole pool; an empty list is how it says "nothing always offered".
    await jf(`${base}/api/mapvote/sets/${made.body.set.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ pool: { dayCount: 2, alwaysOffer: [] } }) });
    const cleared = (await jf(`${base}/api/servers/${id}/mapvote/config`, { headers: auth })).body.profiles[0].pool;
    assert.deepEqual(cleared.alwaysOffer ?? [], []);
  });
});

test("a map set's always-offer list is read in one pass, however long a client makes it", () => {
  // Distinct entries are the worst case for a pairwise de-duplication: every one is compared with
  // every one before it. The editor never sends more than ten; a crafted request can send this.
  const long = Array.from({ length: 20_000 }, (_, i) => `map${i}_warfare`);
  const started = performance.now();
  const pool = parsePoolConfig({ alwaysOffer: long });
  const ms = performance.now() - started;
  assert.deepEqual(pool.alwaysOffer, long.slice(0, 10));
  assert.ok(ms < 1000, `reading the list took ${Math.round(ms)}ms`);
});

