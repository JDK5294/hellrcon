/**
 * Changing the map on a server that answers, rather than one behind a closed port.
 *
 * The closed-port tests in maps-api pin the gating and the refusals; nothing could reach the part
 * that reads the server's own ChangeMap option list and decides what to do with it. That list is
 * the thing this route got wrong twice: first by assuming another command's vocabulary applied to
 * it, then by treating it as a permission list and greying out a whole catalogue of maps that the
 * server would happily load once they were in the rotation.
 *
 * The fake models the live behaviour exactly: ChangeMap's reference data IS the rotation, and a
 * switch to a map outside it answers 200 and does nothing. Under that server, "sent it and reported
 * success" is a lie the tests here exist to catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer, jf } from "./harness.ts";
import { extractConfigValue } from "../dist/routes/kit.js";

async function ownerToken(base: string): Promise<string> {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

test("a map outside ChangeMap's list is staged into the rotation and then switched to", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["foy_warfare", "carentan_warfare", "kharkov_warfare"];
    fake.rotation = ["foy_warfare"]; // what a server mid-vote looks like: one map queued
    try {
      // The catalogue read reports both vocabularies, and they differ — that difference is the
      // whole situation the panel has to explain rather than hide.
      const maps = await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth });
      assert.equal(maps.status, 200);
      assert.equal((maps.body.maps as unknown[]).length, 3);
      assert.deepEqual(maps.body.changeable, ["foy_warfare"]);

      // Refusal remains available, but only on request: a caller that explicitly forbids the
      // rotation edit gets the explanation instead of the append.
      const bare = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare", stage: false }),
      });
      assert.equal(bare.status, 400);
      assert.match(String(bare.body.error?.message ?? ""), /rotation/i);
      assert.deepEqual(fake.rotation, ["foy_warfare"]);
      assert.equal(fake.changedTo, null);

      // The DEFAULT is one click doing the whole job: the map joins the rotation and the switch
      // lands — the sequence an admin would do by hand. Deciding this from the caller's side is
      // exactly what went wrong in the field: the panel's snapshot of the change list went stale
      // the moment the vote collapsed the rotation, and staff got the refusal above for a map
      // they had already confirmed.
      const staged = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare" }),
      });
      assert.equal(staged.status, 200);
      assert.equal(staged.body.staged, true);
      assert.equal(staged.body.listed, true, "after staging the server does list the map");
      assert.equal(staged.body.voteHoldUntil, null, "voting is off on this server — nothing to hold");
      assert.deepEqual(fake.rotation, ["foy_warfare", "carentan_warfare"]);
      assert.equal(fake.changedTo, "carentan_warfare");

      // Staging is not blind: a map the server already lists is switched to directly.
      const direct = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "foy_warfare", stage: true }),
      });
      assert.equal(direct.status, 200);
      assert.equal(direct.body.staged, false);
      assert.equal(fake.changedTo, "foy_warfare");
      assert.deepEqual(fake.rotation, ["foy_warfare", "carentan_warfare"], "no duplicate rotation entry");

      // And the staged switch is in the audit trail as what it was: a map change that edited the
      // rotation, not a bare map change.
      const audit = await jf(`${base}/api/audit`, { headers: auth });
      const entry = (audit.body.entries as any[]).find((e) => e.action === "map.change" && e.data?.staged === true);
      assert.ok(entry, "the staged change is audited");
      assert.match(String(entry.summary), /rotation/i);
    } finally { fake.close(); }
  });
});

/*
 * A human picking the map outranks the vote robot — for five minutes.
 *
 * The manual change ends the round, which is exactly the moment the vote worker would close its
 * poll and queue ITS winner over the human's pick. So a change on a vote-enabled server writes a
 * stand-down instant into the vote state; the worker honors it (closes the open vote without
 * applying, opens nothing new until it passes), and the response carries it so both panels can
 * tell staff they have that window to pause voting if the change is meant to stick.
 */
test("a manual map change puts the vote automation on a five-minute hold", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["foy_warfare", "carentan_warfare"];
    fake.rotation = ["foy_warfare"];
    await repo.mapVote.setConfig(serverId, { enabled: true, surface: "ingame" });
    try {
      const before = Date.now();
      const r = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare" }),
      });
      assert.equal(r.status, 200);
      const until = Date.parse(String(r.body.voteHoldUntil));
      assert.ok(Number.isFinite(until), "the response says when voting resumes");
      assert.ok(until - before >= 4.5 * 60_000 && until - before <= 5.5 * 60_000, "about five minutes out");
      const state = await repo.mapVote.getState(serverId);
      assert.equal(state?.manualHoldUntil, new Date(until).toISOString(), "the worker reads the same instant from the state");

      // "Play this next" is the same fight one button over: without the hold, the vote's
      // live-leader tracker re-queues ITS map on the next tick and the human's pick never plays.
      await repo.mapVote.patchState(serverId, { manualHoldUntil: null });
      const n = await jf(`${base}/api/servers/${serverId}/maps/next`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "foy_warfare" }),
      });
      assert.equal(n.status, 200);
      assert.ok(Number.isFinite(Date.parse(String(n.body.voteHoldUntil))), "queuing a next map holds the vote too");
      assert.equal((await repo.mapVote.getState(serverId))?.manualHoldUntil, new Date(Date.parse(String(n.body.voteHoldUntil))).toISOString());
    } finally { fake.close(); }
  });
});

/*
 * What the game plays next, read from the game — not entry 1 of the list. The field case: the vote
 * paused, two skirmish maps at 1 and 2 and two more appended at 3 and 4, with the game's place on
 * entry 2. Entry 3 played (the map already in play) and the editor gave no hint it would.
 */
test("the maps read names the map the game plays next: the entry after its own place", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["smdm_skirmish", "sme_skirmish", "smdm_warfare", "carentan_warfare"];
    fake.rotation = ["smdm_skirmish", "sme_skirmish", "smdm_warfare", "carentan_warfare"];
    fake.rotationIndex = 1;
    try {
      const read = async () => (await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body;
      const field = await read();
      assert.equal(field.nextIndex, 2, "the entry after the game's place");
      assert.equal(field.next?.id, "smdm_warfare");
      // Where the game sits decides it, not where the list starts.
      fake.rotationIndex = 3;
      const wrapped = await read();
      assert.equal(wrapped.nextIndex, 0);
      assert.equal(wrapped.next?.id, "smdm_skirmish");
    } finally { fake.close(); }
  });
});

/*
 * "Check from game": the read also asks the game for its own play queue and its shuffle switch,
 * the two things that decide what plays next more than the list order does — and says when it
 * asked. A server that answers neither leaves both unknown rather than failing the page.
 */
test("check from game: the game's own queue and shuffle ride along, unknown when unanswered", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["smdm_skirmish", "sme_skirmish"];
    fake.rotation = ["smdm_skirmish", "sme_skirmish"];
    fake.rotationIndex = 1;
    try {
      const read = async () => (await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body;
      const silent = await read();
      assert.equal(silent.queue, null, "no queue answer — nothing invented");
      assert.equal(silent.shuffle, null, "no shuffle answer — unknown, not off");
      assert.ok(Number.isFinite(Date.parse(String(silent.checkedAt))), "the read says when the game was asked");

      // The game answers both: shuffle off, and a queue that agrees with the rotation.
      fake.sequence = ["smdm_skirmish", "sme_skirmish"];
      fake.sequenceIndex = 1;
      fake.shuffle = false;
      const agree = await read();
      assert.equal(agree.shuffle, false);
      assert.deepEqual(agree.queue.maps.map((m: { id: string }) => m.id), ["smdm_skirmish", "sme_skirmish"]);
      assert.equal(agree.queue.next?.id, "smdm_skirmish");
      assert.equal(agree.next?.id, "smdm_skirmish", "the two answers agree");

      // Shuffled, the queue can name a different map from the rotation — both are reported.
      fake.shuffle = true;
      fake.sequence = ["sme_skirmish", "smdm_skirmish"];
      fake.sequenceIndex = 0;
      const shuffled = await read();
      assert.equal(shuffled.shuffle, true);
      assert.equal(shuffled.queue.next?.id, "smdm_skirmish");
      fake.sequenceIndex = 1;
      const differs = await read();
      assert.equal(differs.queue.next?.id, "sme_skirmish");
      assert.equal(differs.next?.id, "smdm_skirmish", "the rotation's answer stands beside the queue's, neither hidden");
    } finally { fake.close(); }
  });
});

/*
 * The game's play queue names its maps by LEVEL PATH where the rotation has the layer id. Shown
 * raw, the field's queue entry read "Game Bnw Maps Fra Smdm Smdm Day — Skirmish Day", and the
 * comparison with the rotation's next map was id against id — never equal, even for the same map,
 * so the "names a different map" warning could not be trusted. Matched by the game's own words.
 */
test("check from game: queue entries named by level path resolve to the rotation's own maps", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    const SMDM = "SMDM_S_1944_Day_P_Skirmish";
    const SME = "SME_S_1944_Day_P_Skirmish";
    fake.catalogue = [SMDM, SME];
    fake.rotation = [SMDM, SME];
    fake.mapDetails.set(SMDM, { name: "ST MARIE DU MONT", gameMode: "Skirmish", timeOfDay: "Day" });
    fake.mapDetails.set(SME, { name: "SAINTE-MÈRE-ÉGLISE", gameMode: "Skirmish", timeOfDay: "Day" });
    fake.rotationIndex = 1; // the rotation's next: entry 1, St Marie Du Mont
    fake.shuffle = true;
    fake.sequence = [
      { iD: "/Game/BNW/Maps/FRA/SME/SME_Day_Skirmish", name: "SAINTE-MÈRE-ÉGLISE", gameMode: "Skirmish", timeOfDay: "Day" },
      { iD: "/Game/BNW/Maps/FRA/SMDM/SMDM_Day_Skirmish", name: "ST MARIE DU MONT", gameMode: "Skirmish", timeOfDay: "Day" },
    ];
    fake.sequenceIndex = 0; // the queue's next: its entry 2, St Marie Du Mont again
    try {
      const body = (await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body;
      assert.deepEqual(body.queue.maps.map((m: { id: string }) => m.id), [SME, SMDM], "the rotation's own ids, not level paths");
      assert.match(body.queue.next.prettyName, /^St Marie Du Mont/, "a name staff recognise");
      assert.doesNotMatch(body.queue.next.prettyName, /Game Bnw/);
      assert.equal(body.queue.next.id, body.next.id, "the same map on both lists now compares equal");
    } finally { fake.close(); }
  });
});

/*
 * Map shuffle is a setting on Administration → Live settings and in Auto settings profiles (the
 * owner's call: not a switch on the Maps tab). The settings read and write carry it — the write is
 * the game's SET, audited like every setting — and a profile may hold it like any other.
 */
test("map shuffle: set on Live settings and by Auto settings profiles", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.shuffle = true;
    try {
      const config = async () => (await jf(`${base}/api/servers/${serverId}/config`, { headers: auth })).body.config;
      assert.equal((await config()).mapShuffle, true, "Live settings reads the game's switch");
      const set = await jf(`${base}/api/servers/${serverId}/config`, { method: "POST", headers: auth, body: JSON.stringify({ mapShuffle: false }) });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body.applied, ["mapShuffle"]);
      assert.equal(fake.shuffle, false, "the game was told to stop shuffling");
      assert.equal((await config()).mapShuffle, false);
      const row = (await repo.audit.list({ limit: 10 })).find((a) => a.action === "config.set");
      assert.match(row!.summary, /mapShuffle = false/);

      const auto = (await jf(`${base}/api/servers/${serverId}/autosettings`, { headers: auth })).body;
      const offered = auto.fields.find((f: { field: string }) => f.field === "mapShuffle");
      assert.ok(offered, "a profile is offered map shuffle");
      assert.equal(offered.kind, "bool");
      const put = await jf(`${base}/api/servers/${serverId}/autosettings`, { method: "PUT", headers: auth,
        body: JSON.stringify({ profiles: [{ name: "Event night", settings: { mapShuffle: false } }] }) });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal((await repo.autosettings.getConfig(serverId))?.profiles[0]?.settings.mapShuffle, false, "and holds it");
    } finally { fake.close(); }
  });
});

test("a setting read in the other case still reads (Enable for enable)", () => {
  assert.equal(extractConfigValue({ Enable: false }, "enable"), false);
  assert.equal(extractConfigValue({ enable: true }, "enable"), true);
  assert.equal(extractConfigValue({ other: 1 }, "enable"), null);
});

/*
 * The pages must SAY when automation owns what they edit — sweep #193's theme. The Maps read
 * carries voteManaged so the rotation editor can explain a vote-collapsed rotation, and the live
 * config read names the Auto settings profile holding fields (live + not dry-run only: a dry-run
 * profile never rewrites anything, so a warning about it would be false).
 */
test("the reads say when automation manages what the page edits", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["foy_warfare"];
    fake.rotation = ["foy_warfare"];
    try {
      assert.equal((await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body.voteManaged, false);
      await repo.mapVote.setConfig(serverId, { enabled: true, surface: "ingame" });
      assert.equal((await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body.voteManaged, true);
      assert.equal((await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body.votePaused, false);
      // Paused, the vote leaves the rotation alone — the editor must not warn that edits get rewritten.
      await repo.mapVote.patchState(serverId, { paused: true, pauseReason: "staff" });
      const paused = (await jf(`${base}/api/servers/${serverId}/maps`, { headers: auth })).body;
      assert.equal(paused.voteManaged, true);
      assert.equal(paused.votePaused, true);

      const profiles = [{ name: "Always", settings: { autoBalanceEnabled: true, idleKickMinutes: 10 } }];
      await repo.autosettings.upsertConfig(serverId, { enabled: true, dryRun: true, timezone: "UTC", profiles });
      const dry = await jf(`${base}/api/servers/${serverId}/config`, { headers: auth });
      assert.equal(dry.status, 200);
      assert.equal(dry.body.managed, null, "a dry-run profile rewrites nothing, so nothing is 'held'");

      await repo.autosettings.upsertConfig(serverId, { dryRun: false });
      const live = await jf(`${base}/api/servers/${serverId}/config`, { headers: auth });
      assert.equal(live.body.managed?.profile, "Always");
      assert.deepEqual([...(live.body.managed?.fields ?? [])].sort(), ["autoBalanceEnabled", "idleKickMinutes"]);

      // A match-time profile above it holds its fields while the match is in that stretch — the
      // banner reads the same match clock the worker does, not only the head count.
      await repo.autosettings.upsertConfig(serverId, { profiles: [
        { name: "Opening", spec: { matchMinutesBelow: 10 }, settings: { autoBalanceEnabled: false } },
        ...profiles,
      ] });
      await repo.matches.open({ serverId, map: "foy_warfare", startedAt: new Date(Date.now() - 3 * 60_000).toISOString() });
      const opening = await jf(`${base}/api/servers/${serverId}/config`, { headers: auth });
      assert.equal(opening.body.managed?.profile, "Opening");
      assert.deepEqual(opening.body.managed?.fields, ["autoBalanceEnabled"]);
    } finally { fake.close(); }
  });
});

test("the server's own spelling wins over the caller's, and a swallowed switch is reported as unlisted", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["Foy_Warfare"];
    fake.rotation = ["Foy_Warfare"];
    try {
      // Two lists of the same maps disagreeing on case used to be a refusal. The server told us
      // how it spells the map; sending it back its own spelling is strictly better than an error.
      const cased = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "foy_warfare" }),
      });
      assert.equal(cased.status, 200);
      assert.equal(cased.body.mapId, "Foy_Warfare");
      assert.equal(fake.changedTo, "Foy_Warfare");

      // A server that lists nothing at all has no opinion to contradict: the command goes through
      // and `listed` says there was nothing to warn about.
      fake.rotation = [];
      fake.catalogue = [];
      fake.changedTo = null;
      const silent = await jf(`${base}/api/servers/${serverId}/maps/change`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "kharkov_warfare", stage: true }),
      });
      assert.equal(silent.status, 200);
      assert.equal(silent.body.listed, true);
      assert.equal(silent.body.verified, false, "the fake swallows it, and the route must not claim otherwise");
      assert.equal(fake.changedTo, null);
    } finally { fake.close(); }
  });
});

/*
 * The rotation must never be emptied.
 *
 * HLL does not treat an empty rotation as empty: it refills it with the ENTIRE map catalogue, which
 * then has to be deleted by hand, one entry at a time, to get back to the handful you wanted. So
 * the innocent-looking click — removing the last map — is the expensive one, and it is refused.
 */
test("the last map in the rotation cannot be removed, but the second-to-last can", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    fake.catalogue = ["foy_warfare", "carentan_warfare"];
    fake.rotation = ["foy_warfare", "carentan_warfare"];
    const remove = (mapId: string) => jf(`${base}/api/servers/${serverId}/maprotation/remove`, {
      method: "POST", headers: auth, body: JSON.stringify({ mapId }),
    });
    try {
      // Down to one: allowed, and it really left the game's rotation.
      assert.equal((await remove("carentan_warfare")).status, 200);
      assert.deepEqual(fake.rotation, ["foy_warfare"]);

      // The last one: refused, and the refusal says why and what to do instead.
      const last = await remove("foy_warfare");
      assert.equal(last.status, 409);
      assert.match(JSON.stringify(last.body), /at least one map/i);
      assert.match(JSON.stringify(last.body), /every map in the catalogue/i);
      assert.deepEqual(fake.rotation, ["foy_warfare"], "the game was never asked — the refusal is before the command");

      // The way out is to add first, then remove: that never leaves the rotation empty.
      assert.equal((await jf(`${base}/api/servers/${serverId}/maprotation/add`, {
        method: "POST", headers: auth, body: JSON.stringify({ mapId: "carentan_warfare" }),
      })).status, 200);
      assert.equal((await remove("foy_warfare")).status, 200);
      assert.deepEqual(fake.rotation, ["carentan_warfare"]);
    } finally {
      fake.close();
    }
  });
});
