import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

// Isolate the CRCON archive files these tests write (read by the routes at call time).
process.env.CRCON_BACKUP_DIR = mkdtempSync(join(tmpdir(), "crcon-bk-api-"));

async function textFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  return { status: res.status, text: await res.text() };
}

/** "Apply to panel" is now a background run: start it, poll the status route to completion, and
 *  return the summary shaped like the old synchronous response so assertions stay unchanged. */
async function applyArchive(base: string, id: string, auth: Record<string, string>, dry = false) {
  const started = await jf(`${base}/api/servers/${id}/import/crcon/transform${dry ? "?dry=1" : ""}`, { method: "POST", headers: auth });
  if (started.status !== 202) return started; // permission/404 failures pass straight through
  for (let i = 0; i < 200; i++) {
    const st = await jf(`${base}/api/servers/${id}/import/crcon/transform/status`, { headers: auth });
    if (st.body.status === "done") return { status: 200, body: st.body.summary };
    if (st.body.status === "error") throw new Error(`transform failed: ${st.body.error}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("transform did not finish in time");
}

test("crcon backup job: start guards, status, pause, and export/upload round-trip", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "bk", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const jobUrl = `${base}/api/servers/${id}/import/crcon/job`;

    // start needs a base URL + key (no network happens here — the worker drives the pull separately)
    assert.equal((await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 400);
    assert.equal((await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({ baseUrl: "https://crcon.example" }) })).status, 400);
    const start = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({ baseUrl: "https://crcon.example", apiKey: "secret-key" }) });
    assert.equal(start.status, 201);
    assert.equal(start.body.job.status, "running");
    // the API key must never come back on the job
    assert.equal("apiKey" in start.body.job, false);

    // status shows the latest job + (empty) archive counts
    const status = await jf(jobUrl, { headers: auth });
    assert.equal(status.body.job.status, "running");
    assert.deepEqual(status.body.archive, []);

    // re-starting while running returns the same running job, not a duplicate
    const again = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(again.body.note, "a pull is already running");

    // pause → paused; re-start resumes
    assert.equal((await jf(`${jobUrl}/pause`, { method: "POST", headers: auth })).body.job.status, "paused");
    assert.equal((await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({}) })).body.note, "resumed");

    // upload an NDJSON backup, then export it back and confirm the record survives the round-trip
    const ndjson = [
      JSON.stringify({ dataType: "vip", entityKey: "111", raw: { player_id: "111", name: "A" } }),
      JSON.stringify({ dataType: "ban", entityKey: "222", raw: { player_id: "222" } }),
      "not-json-line",
      JSON.stringify({ missing: "keys" }),
    ].join("\n");
    // …but not while the pull is running: the worker is appending to the very file the upload
    // would replace, so the route refuses rather than racing it.
    const blocked = await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    assert.equal(blocked.status, 409);
    await jf(`${jobUrl}/pause`, { method: "POST", headers: auth });
    const up = await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    assert.equal(up.body.imported, 2);
    assert.equal(up.body.skipped, 2);

    const exp = await textFetch(`${base}/api/servers/${id}/import/crcon/export`, { headers: auth });
    assert.equal(exp.status, 200);
    const lines = exp.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.dataType === "vip" && l.entityKey === "111" && l.raw.name === "A"));
  });
});

test("crcon transform: archive → our systems, idempotent on re-run", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "tf", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // Seed the archive directly via upload (stands in for a completed pull). The player DB has the
    // REAL names; the VIP row deliberately carries a wrong/label name to exercise normalization,
    // and player 222's profile is flagged watched. The blacklist rows ride along to prove they are
    // ARCHIVED but no longer imported — the blacklist is retired (docs/ban-model.md).
    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      // 222's real name comes ONLY via CRCON's `names` history array (no flat field) — exercises the
      // array extraction that normalizes VIP labels back to gamertags.
      { dataType: "player", entityKey: "222", raw: { player_id: "222", names: [{ name: "Bravo", last_seen: "2026-01-02T00:00:00Z" }, { name: "OldBravo", last_seen: "2020-01-01T00:00:00Z" }] } },
      { dataType: "vip", entityKey: "111", raw: { player_id: "111", name: "Bulk payout: filters", vip_expiration: "never" } },
      { dataType: "blacklist", entityKey: "9", raw: { id: "9", name: "Cheaters" } },
      { dataType: "blacklist_record", entityKey: "r1", raw: { id: "r1", blacklist_id: "9", player_id: "222", reason: "aimbot", admin_name: "AdminJoe" } },
      { dataType: "standard_message", entityKey: "m1", raw: { kind: "broadcast", message: "Welcome to the server" } },
      { dataType: "player_detail", entityKey: "111", raw: { player_id: "111", name: "Alpha", comments: [{ content: "known toxic", by: "admin" }], sessions: [{ start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" }, { start: "2026-01-02T00:00:00Z", end: "2026-01-02T00:30:00Z" }] } },
      { dataType: "player_detail", entityKey: "222", raw: { player_id: "222", name: "Bravo", watchlist: true } },
      // Bans go to the Bans view (their own store), never the Blacklist — both temp and perma.
      { dataType: "ban", entityKey: "b333", raw: { player_id: "333", type: "perma", reason: "cheating", admin_name: "AdminSam" } },
      { dataType: "ban", entityKey: "b444", raw: { player_id: "444", ban_type: "temp", reason: "tk", expires_at: "2031-01-01T00:00:00Z", admin_name: "AdminSam" } },
      { dataType: "ban", entityKey: "b222", raw: { player_id: "222", type: "perma", reason: "aimbot" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    const up = await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    assert.equal(up.body.imported, 11);

    const t1 = await applyArchive(base, id, auth);
    assert.equal(t1.status, 200);
    assert.equal(t1.body.players, 2);
    assert.equal(t1.body.vips, 1);
    assert.equal(t1.body.bans, 3);      // all three CRCON bans (temp + perma) go to the import archive
    assert.equal(t1.body.notes, 1);
    assert.equal(t1.body.messages, 1);
    assert.equal(t1.body.sessions, 2); // player 111's two profile sessions imported
    assert.equal(t1.body.watchlist, 1); // derived from player 222's profile
    assert.equal(t1.body.blacklists, undefined, "blacklists are archived, never imported");
    assert.equal(t1.body.blacklistRecords, undefined);

    // VIP name normalized from the player DB (not the "Bulk payout: filters" label).
    const vips = await jf(`${base}/api/servers/${id}/vips`, { headers: auth });
    const vip = (vips.body.vips as any[]).find((v) => v.playerId === "111");
    assert.equal(vip.playerName, "Alpha");
    // Imported bans land in the crcon_ban import archive — temp AND perma, all three, with the
    // original CRCON admin preserved. They do NOT surface on the Bans page: that page shows the
    // community's own decisions, and adopting the game's live lists is the seed's job.
    const imported = await repo.crconBans.list({ serverId: id });
    assert.deepEqual(imported.map((b) => b.playerId).sort(), ["222", "333", "444"]);
    const b444 = imported.find((b) => b.playerId === "444");
    assert.equal(b444!.type, "temp");
    assert.equal(b444!.author, "AdminSam"); // CRCON admin preserved as the ban author
    assert.equal(imported.find((b) => b.playerId === "333")!.type, "perma");
    const bansView = await jf(`${base}/api/bans`, { headers: auth });
    assert.equal((bansView.body.bans as any[]).length, 0, "the archive does not leak onto the Bans page");

    // Re-running converges: skip/upsert-based types add nothing new the second time.
    const t2 = await applyArchive(base, id, auth);
    assert.equal(t2.body.bans, 0);
    assert.equal(t2.body.notes, 0);
    assert.equal(t2.body.messages, 0);
    assert.equal(t2.body.sessions, 0); // sessions dedupe — no re-count, no double playtime
  });
});

test("imported moderation carries CRCON's own times — and a re-apply repairs rows an older import stamped late", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "when", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // The damage an OLDER import left behind: a ban and a note, both stamped at the moment that
    // import ran instead of when the moderation actually happened.
    await repo.crconBans.upsert({ serverId: id, playerId: "111", playerName: "Cheater", type: "perma", reason: "aimbot" });
    const alpha = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "333", name: "Alpha", ts: "2023-01-01T00:00:00.000Z" });
    await repo.playerNotes.create({ playerId: alpha.id, authorName: "admin", body: "[CRCON] known toxic" });

    // The archive carries the same records WITH their real CRCON stamps.
    const ndjson = [
      { dataType: "ban", entityKey: "b1", raw: { player_id: "111", name: "Cheater", type: "perma", reason: "aimbot", ban_time: "2023-04-05T12:00:00" } },
      { dataType: "player_detail", entityKey: "333", raw: { player_id: "333", name: "Alpha", comments: [{ content: "known toxic", by: "admin", creation_time: "2023-02-03T08:00:00" }] } },
      // A brand-new ban with a stamp lands with that stamp from the start.
      { dataType: "ban", entityKey: "b2", raw: { player_id: "444", name: "Newcomer", type: "temp", reason: "tk", expires_at: "2031-01-01T00:00:00Z", ban_time: "2024-06-07T10:00:00" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);

    const bans = await repo.crconBans.list({ serverId: id });
    assert.equal(bans.find((b) => b.playerId === "111")?.createdAt, "2023-04-05T12:00:00.000Z", "the damaged ban is lowered onto its real moment");
    assert.equal(bans.find((b) => b.playerId === "444")?.createdAt, "2024-06-07T10:00:00.000Z", "a fresh import lands with the record's stamp");
    const notes = await repo.playerNotes.list(alpha.id);
    assert.equal(notes.find((n) => n.body === "[CRCON] known toxic")?.createdAt, "2023-02-03T08:00:00.000Z", "and the note");

    // Re-running moves nothing further and counts nothing twice.
    const t2 = await applyArchive(base, id, auth);
    assert.equal(t2.body.notes, 0);
    assert.equal((await repo.crconBans.list({ serverId: id })).find((b) => b.playerId === "111")?.createdAt, "2023-04-05T12:00:00.000Z");
  });
});

test("the archive fills the whole profile: sessions+playtime from log pairs, aliases, moderation, faction", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "fill", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const ndjson = [
      // A profile with NO sessions array (plenty of CRCON instances don't keep one) but a name
      // history and the received_actions CRCON's own player page shows.
      { dataType: "player_detail", entityKey: "111", raw: {
        player_id: "111", name: "Kreitz",
        names: [{ name: "Kreitz", last_seen: "2026-03-01T14:00:00Z" }, { name: "OldKreitz", last_seen: "2025-07-03T00:12:35Z" }],
        received_actions: [
          { action_type: "PUNISH", reason: "yousa beeeen a bad boi", by: "Discord_VIP_bot", time: "2026-04-14T23:36:00Z" },
          { action_type: "PERMABAN", reason: "test", by: "Discord_VIP_bot", time: "2026-04-14T23:38:00Z" },
          { action_type: "TEMPBAN", reason: "Test", by: "Discord_VIP_bot", time: "2026-03-25T02:28:00Z" },
        ],
      } },
      // The presence record: two connect/disconnect pairs — 2h and 30m.
      { dataType: "log_connect", entityKey: "c1", raw: { id: "c1", action: "CONNECTED", event_time: "2026-03-01T10:00:00Z", player1_id: "111", player1_name: "Kreitz" } },
      { dataType: "log_disconnect", entityKey: "d1", raw: { id: "d1", action: "DISCONNECTED", event_time: "2026-03-01T12:00:00Z", player1_id: "111", player1_name: "Kreitz" } },
      { dataType: "log_connect", entityKey: "c2", raw: { id: "c2", action: "CONNECTED", event_time: "2026-03-02T10:00:00Z", player1_id: "111", player1_name: "Kreitz" } },
      { dataType: "log_disconnect", entityKey: "d2", raw: { id: "d2", action: "DISCONNECTED", event_time: "2026-03-02T10:30:00Z", player1_id: "111", player1_name: "Kreitz" } },
      // A connect with no disconnect (crash) must not invent a session.
      { dataType: "log_connect", entityKey: "c3", raw: { id: "c3", action: "CONNECTED", event_time: "2026-03-03T10:00:00Z", player1_id: "111", player1_name: "Kreitz" } },
      // Kills whose lines carry sides — with no sided match rows, faction comes from these.
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", event_time: "2026-03-01T10:30:00Z", type: "KILL", player1_id: "111", player1_name: "Kreitz", player2_id: "222", player2_name: "Bravo", weapon: "MP40", content: "KILL: Kreitz(Axis/111) -> Bravo(Allies/222) with MP40" } },
      { dataType: "log_kill", entityKey: "k2", raw: { id: "k2", event_time: "2026-03-01T10:40:00Z", type: "KILL", player1_id: "111", player1_name: "Kreitz", player2_id: "222", player2_name: "Bravo", weapon: "MP40", content: "KILL: Kreitz(Axis/111) -> Bravo(Allies/222) with MP40" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);
    assert.equal(t.body.sessions, 2, "both complete pairs became sessions; the dangling connect did not");
    assert.equal(t.body.playtimeSec, 2 * 3600 + 30 * 60, "and their seconds joined career playtime");
    assert.ok((t.body.aliases as number) >= 1, "the name history was folded");

    const player = (await repo.players.findByPlatformId("111"))!;
    assert.equal((await repo.sessions.list(player.id, 10)).length, 2);
    assert.equal((await repo.stats.get(player.id, id))?.playtimeSec, 9000);
    const aliases = await repo.playerAliases.list(player.id);
    const old = aliases.find((a) => a.value === "OldKreitz");
    assert.ok(old, "the historical name is on record");
    assert.equal(old.lastSeen, "2025-07-03T00:12:35.000Z", "at ITS time, not the import's");

    // The profile now shows it all: moderation from received_actions, faction from the kill sides.
    const prof = await jf(`${base}/api/players/${player.id}`, { headers: auth });
    const mod = prof.body.moderation as { action: string; actorName: string; ts: string; summary: string }[];
    assert.ok(mod.some((m) => m.action === "player.punish" && m.actorName === "Discord_VIP_bot"), "the CRCON punish shows");
    assert.ok(mod.some((m) => m.action === "player.permaban" && m.ts === "2026-04-14T23:38:00.000Z"), "the permaban, at the CRCON time");
    assert.ok(mod.some((m) => m.action === "player.tempban"), "and the tempban");
    assert.equal(prof.body.combat.faction.alliesPct, 0, "every sided kill was Axis → 0% Allies, not a blank");
    assert.ok(prof.body.combat.rates.kpm !== null, "playtime exists, so kills/min computes");

    // Re-running derives nothing twice.
    const t2 = await applyArchive(base, id, auth);
    assert.equal(t2.body.sessions, 0);
    assert.equal(t2.body.playtimeSec, 0);
    assert.equal((await repo.stats.get(player.id, id))?.playtimeSec, 9000);
    assert.equal((await repo.sessions.list(player.id, 10)).length, 2);
  });
});

test("crcon transform: kill history → events+stats, map history → matches, flags → tags; all idempotent", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "hist", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      // A kill row carrying a STALE name must not regress the player DB's current name.
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", event_time: "2026-03-01T10:00:00", type: "KILL", player1_id: "111", player1_name: "AlphaOld", player2_id: "222", player2_name: "Bravo", weapon: "M1 GARAND" } },
      // No flat weapon — parsed out of the raw log line.
      { dataType: "log_kill", entityKey: "k2", raw: { id: "k2", event_time: "2026-03-01T10:05:00", type: "KILL", player1_id: "111", player1_name: "AlphaOld", player2_id: "222", player2_name: "Bravo", content: "KILL: AlphaOld(Allies/111) -> Bravo(Axis/222) with MP40" } },
      { dataType: "log_teamkill", entityKey: "t1", raw: { id: "t1", event_time: "2026-03-01T10:07:00", type: "TEAM KILL", player1_id: "111", player1_name: "AlphaOld", player2_id: "333", player2_name: "Chuck", weapon: "MK2 GRENADE" } },
      // Old-style map history (flat name, unix seconds) and new-style (nested map, result scores).
      { dataType: "map_history", entityKey: "m1", raw: { name: "carentan_warfare", start: 1770000000, end: 1770005400 } },
      { dataType: "map_history", entityKey: "m2", raw: { map: { id: "kursk_offensive_ger" }, start: "2026-03-01T12:00:00", end: "2026-03-01T13:10:00", result: { allied: 2, axis: 3 } } },
      // A round switched away from 40 seconds in: not a game, so it never becomes a match.
      { dataType: "map_history", entityKey: "m3", raw: { name: "foy_warfare", start: 1770010000, end: 1770010040 } },
      // Profile flags (CRCON's emoji labels) become player tags.
      { dataType: "player_detail", entityKey: "111", raw: { player_id: "111", name: "Alpha", flags: [{ flag: "🎥", comment: "streams" }, { flag: "⭐" }] } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t1 = await applyArchive(base, id, auth);
    assert.equal(t1.status, 200);
    assert.equal(t1.body.kills, 2);
    assert.equal(t1.body.teamkills, 1);
    assert.equal(t1.body.matches, 2);
    assert.equal(t1.body.tags, 2);

    // Career stats accumulated from the history: Alpha 2 kills + 1 TK, Bravo 2 deaths.
    const alpha = await jf(`${base}/api/players/111`, { headers: auth });
    assert.equal(alpha.body.player.name, "Alpha"); // stale kill-row name did NOT win
    assert.equal(alpha.body.stats.kills, 2);
    assert.equal(alpha.body.stats.teamkills, 1);
    assert.equal((await jf(`${base}/api/players/222`, { headers: auth })).body.stats.deaths, 2);
    // Tags landed (label = emoji + comment).
    assert.deepEqual((alpha.body.tags as any[]).map((t) => t.label).sort(), ["869 streams".replace("869", "\u{1F3A5}"), "⭐"].sort());

    // The kills are real events: filterable by player + kind, weapons preserved (incl the parsed one).
    const evs = await jf(`${base}/api/servers/${id}/events?player=111&kinds=evt.kill`, { headers: auth });
    assert.deepEqual((evs.body.events as any[]).map((e) => e.weapon).sort(), ["M1 GARAND", "MP40"]);

    // Map history became finished matches (both shapes), with the scored round attributed.
    const matches = await jf(`${base}/api/servers/${id}/matches?limit=100`, { headers: auth });
    const maps = (matches.body.matches as any[]).map((m) => m.map).sort();
    assert.deepEqual(maps, ["carentan_warfare", "kursk_offensive_ger"], "and the 40-second round is not one of them");

    // Re-run converges: nothing double-counts.
    const t2 = await applyArchive(base, id, auth);
    assert.equal(t2.body.kills, 0);
    assert.equal(t2.body.teamkills, 0);
    assert.equal(t2.body.matches, 0);
    assert.equal(t2.body.tags, 0);
    assert.equal((await jf(`${base}/api/players/111`, { headers: auth })).body.stats.kills, 2); // unchanged
  });
});

test("crcon transform: full log history → typed events, visits, and per-player win/loss attribution", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "full", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const ndjson = [
      // A finished, scored round: 12:00→13:10, axis win 3-2.
      { dataType: "map_history", entityKey: "m1", raw: { map: { id: "carentan_warfare" }, start: "2026-03-01T12:00:00", end: "2026-03-01T13:10:00", result: { allied: 2, axis: 3 } } },
      // Kills INSIDE that round, sides embedded in the log line — Alpha(Allies), Bravo(Axis).
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", event_time: "2026-03-01T12:30:00", type: "KILL", player1_id: "111", player1_name: "Alpha", player2_id: "222", player2_name: "Bravo", weapon: "MP40", content: "KILL: Alpha(Allies/111) -> Bravo(Axis/222) with MP40" } },
      { dataType: "log_kill", entityKey: "k2", raw: { id: "k2", event_time: "2026-03-01T12:45:00", type: "KILL", player1_id: "222", player1_name: "Bravo", player2_id: "111", player2_name: "Alpha", weapon: "KARABINER 98K", content: "KILL: Bravo(Axis/222) -> Alpha(Allies/111) with KARABINER 98K" } },
      // The rest of the vocabulary.
      { dataType: "log_connect", entityKey: "c1", raw: { id: "c1", event_time: "2026-03-01T11:55:00", type: "CONNECTED", player1_id: "111", player1_name: "Alpha" } },
      { dataType: "log_disconnect", entityKey: "d1", raw: { id: "d1", event_time: "2026-03-01T13:12:00", type: "DISCONNECTED", player1_id: "111", player1_name: "Alpha" } },
      { dataType: "log_chat", entityKey: "ch1", raw: { id: "ch1", event_time: "2026-03-01T12:10:00", type: "CHAT[Allies][Team]", player1_id: "111", player1_name: "Alpha", content: "Alpha: push left", sub_content: "push left" } },
      { dataType: "log_chat", entityKey: "ch2", raw: { id: "ch2", event_time: "2026-03-01T12:11:00", type: "CHAT[Allies][Unit]", player1_id: "111", player1_name: "Alpha", sub_content: "on me" } },
      { dataType: "log_match", entityKey: "ms1", raw: { id: "ms1", event_time: "2026-03-01T12:00:00", type: "MATCH START", content: "MATCH START CARENTAN WARFARE" } },
      { dataType: "log_match", entityKey: "me1", raw: { id: "me1", event_time: "2026-03-01T13:10:00", type: "MATCH ENDED", content: "MATCH ENDED `CARENTAN WARFARE` AXIS (3 - 2)" } },
      { dataType: "log_admin", entityKey: "ak1", raw: { id: "ak1", event_time: "2026-03-01T12:50:00", type: "ADMIN KICKED", player1_id: "333", player1_name: "Chuck", content: "toxic chat" } },
      { dataType: "log_vote", entityKey: "v1", raw: { id: "v1", event_time: "2026-03-01T13:00:00", type: "VOTE COMPLETED", content: "vote passed against Chuck" } },
      { dataType: "log_teamswitch", entityKey: "sw1", raw: { id: "sw1", event_time: "2026-03-01T12:20:00", type: "TEAMSWITCH", player1_id: "222", player1_name: "Bravo", content: "TEAMSWITCH Bravo (Axis > Allies)" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t1 = await applyArchive(base, id, auth);
    assert.equal(t1.status, 200);
    assert.equal(t1.body.kills, 2);
    assert.equal(t1.body.matches, 1);
    assert.equal(t1.body.visits, 1);
    assert.equal(t1.body.events, 9);      // connect + disconnect + 2 chat + 2 match + kick + vote + switch
    assert.equal(t1.body.matchStats, 4);  // 2 kills × (actor line + victim line)

    // Kinds landed on our vocabulary and filter correctly.
    const kindOf = async (kinds: string) => ((await jf(`${base}/api/servers/${id}/events?kinds=${kinds}`, { headers: auth })).body.events as any[]).map((e) => e.kind);
    assert.deepEqual((await kindOf("evt.chat.team,evt.chat.squad")).sort(), ["evt.chat.squad", "evt.chat.team"]);
    assert.deepEqual(await kindOf("evt.player.connected"), ["evt.player.connected"]);
    assert.deepEqual((await kindOf("evt.match.started,evt.match.ended")).length, 2);
    assert.deepEqual(await kindOf("evt.player.kicked"), ["evt.player.kicked"]);
    assert.deepEqual(await kindOf("evt.vote.completed"), ["evt.vote.completed"]);

    // Win/loss history rebuilt: Alpha (Allies) lost the axis-won round; Bravo (Axis) won it.
    const alpha = await jf(`${base}/api/players/111`, { headers: auth });
    assert.equal(alpha.body.matchAnalytics.aggregate.matches, 1);
    assert.equal(alpha.body.matchAnalytics.aggregate.losses, 1);
    assert.equal(alpha.body.matchAnalytics.aggregate.wins, 0);
    assert.equal(alpha.body.stats.visits, 1);
    const bravo = await jf(`${base}/api/players/222`, { headers: auth });
    assert.equal(bravo.body.matchAnalytics.aggregate.wins, 1);
    // And the social graph: they were on opposite sides.
    assert.deepEqual((alpha.body.combat.playedAgainst as any[]).map((p) => p.name), ["Bravo"]);

    // Re-run converges completely.
    const t2 = await applyArchive(base, id, auth);
    assert.equal(t2.body.kills + t2.body.events + t2.body.visits + t2.body.matchStats + t2.body.matches, 0);
    assert.equal((await jf(`${base}/api/players/111`, { headers: auth })).body.matchAnalytics.aggregate.losses, 1);
  });
});

test("crcon transform: the overlap cutoff — history after the panel's own first event is skipped", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "cut", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // the panel started observing this server at T — a locally-ingested event (non-crcon dedupe key).
    await repo.events.insert([{ serverId: id, ts: "2026-05-01T00:00:00.000Z", kind: "evt.kill", actorPlayerId: null, actorName: "X", victimPlayerId: null, victimName: "Y", weapon: "MP40", data: null, dedupeKey: "live-line-1" }]);

    const ndjson = [
      // one kill BEFORE the cutoff, one AFTER (CRCON's copy of what live ingest already counted)
      { dataType: "log_kill", entityKey: "old", raw: { id: "old", event_time: "2026-04-30T10:00:00", type: "KILL", player1_id: "111", player1_name: "Alpha", player2_id: "222", player2_name: "Bravo", weapon: "MP40" } },
      { dataType: "log_kill", entityKey: "new", raw: { id: "new", event_time: "2026-05-02T10:00:00", type: "KILL", player1_id: "111", player1_name: "Alpha", player2_id: "222", player2_name: "Bravo", weapon: "MP40" } },
      { dataType: "log_connect", entityKey: "cnew", raw: { id: "cnew", event_time: "2026-05-02T09:00:00", type: "CONNECTED", player1_id: "111", player1_name: "Alpha" } },
      { dataType: "map_history", entityKey: "mnew", raw: { name: "foy_warfare", start: "2026-05-02T08:00:00", end: "2026-05-02T09:30:00" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t = await applyArchive(base, id, auth);
    assert.equal(t.body.kills, 1);    // only the pre-cutoff kill
    assert.equal(t.body.events, 0);   // the connect was post-cutoff
    assert.equal(t.body.matches, 0);  // the round was post-cutoff (live tracking owns it)
    assert.equal((await jf(`${base}/api/players/111`, { headers: auth })).body.stats.kills, 1);
  });
});

test("crcon backup job: a rotated API key can revive a stopped pull, and a fresh start is possible", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "rot", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const jobUrl = `${base}/api/servers/${id}/import/crcon/job`;

    const start = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({ baseUrl: "https://old.example", apiKey: "old-key" }) });
    const jobId = start.body.job.id as string;
    assert.equal(await repo.crconSnapshot.getJobApiKey(jobId), "old-key");

    // the pull dies the way a real one does: the key was rotated in CRCON
    await repo.crconSnapshot.updateJob(jobId, { status: "error", errors: ["401 unauthorized"] });

    // resuming WITH new credentials must update them in place and clear the stale error list,
    // otherwise a stopped pull can never be revived (the panel's dead end).
    const resumed = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({ baseUrl: "https://new.example", apiKey: "new-key" }) });
    assert.equal(resumed.body.note, "resumed with new credentials");
    assert.equal(resumed.body.job.status, "running");
    assert.equal(resumed.body.job.baseUrl, "https://new.example");
    assert.deepEqual(resumed.body.job.errors, []);
    assert.equal(await repo.crconSnapshot.getJobApiKey(jobId), "new-key");
    assert.equal("apiKey" in resumed.body.job, false); // still never leaked

    // resuming with nothing keeps whatever is saved
    await repo.crconSnapshot.updateJob(jobId, { status: "paused" });
    const plain = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(plain.body.note, "resumed");
    assert.equal(await repo.crconSnapshot.getJobApiKey(jobId), "new-key");

    // restart: true abandons the stopped job and creates a brand-new one
    await repo.crconSnapshot.updateJob(jobId, { status: "paused" });
    const fresh = await jf(jobUrl, { method: "POST", headers: auth, body: JSON.stringify({ restart: true, baseUrl: "https://new.example", apiKey: "fresh-key" }) });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.note, "started");
    assert.notEqual(fresh.body.job.id, jobId);
    assert.equal(await repo.crconSnapshot.getJobApiKey(fresh.body.job.id as string), "fresh-key");
  });
});

test("crcon transform: IP history from profiles and old-era connect lines, permission-gated", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "ips", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      { dataType: "player", entityKey: "222", raw: { player_id: "222", name: "Bravo" } },
      // Profile IPs in every shape CRCON has used: flat field, list entries, per-session addresses.
      { dataType: "player_detail", entityKey: "111", raw: { player_id: "111", name: "Alpha", last_ip: "10.1.1.1", ip_addresses: [{ ip: "89.10.11.12", last_seen: "2025-05-01T00:00:00Z" }], sessions: [{ start: "2025-06-01T00:00:00Z", end: "2025-06-01T01:00:00Z", ip: "89.10.11.12" }] } },
      // Old-era CONNECTED line: name + ip:port, NO player id — NEVER attributed (matching by
      // name would be guessing which IP belongs to which player), so it records nothing.
      { dataType: "log_connect", entityKey: "lc1", raw: { id: "lc1", action: "CONNECTED", event_time: "2021-03-01T00:00:00Z", player1_name: "Bravo", content: "CONNECTED Bravo (89.10.11.12:64015)" } },
      // A row that carries BOTH the player id and an address: safely attributed to that id.
      { dataType: "log_connect", entityKey: "lc2", raw: { id: "lc2", action: "CONNECTED", event_time: "2024-01-01T00:00:00Z", player1_id: "222", player1_name: "Bravo", content: "CONNECTED Bravo (89.10.11.12:64015)" } },
      // Modern CONNECTED line: id in parens, no IP → nothing recorded from it.
      { dataType: "log_connect", entityKey: "lc3", raw: { id: "lc3", action: "CONNECTED", event_time: "2026-01-01T00:00:00Z", player1_id: "111", player1_name: "Alpha", content: "CONNECTED Alpha (111)" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);
    assert.ok(t.body.ips >= 3); // flat + list + session (dupes widen, not multiply) + the old log line

    const alpha = (await repo.players.findByPlatformId("111"))!;
    const bravo = (await repo.players.findByPlatformId("222"))!;

    // Owner (all-access) reads the panel data; the shared-IP cross-reference links the two players.
    const r = await jf(`${base}/api/players/${alpha.id}/ips`, { headers: auth });
    assert.equal(r.status, 200);
    const ips = r.body.ips as { ip: string; sharedWith: { playerId: string }[]; seenCount: number }[];
    const shared = ips.find((x) => x.ip === "89.10.11.12")!;
    assert.ok(shared, "profile ip recorded");
    assert.ok(ips.some((x) => x.ip === "10.1.1.1"), "flat last_ip recorded");
    assert.ok(shared.sharedWith.some((sp) => sp.playerId === bravo.id), "id-carrying connect row attributed to Bravo → shared-ip crossref");
    // The id-less old-era line must NOT have credited anyone: Bravo's only sighting is the
    // id-carrying row (count 1), not the name-only one.
    const br = await jf(`${base}/api/players/${bravo.id}/ips`, { headers: auth });
    const bravoIp = (br.body.ips as { ip: string; seenCount: number }[]).find((x) => x.ip === "89.10.11.12")!;
    assert.equal(bravoIp.seenCount, 1);

    // A staff member without player.ips gets a 403 naming the capability — the panel hides on it.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "noips", password: "pw" }) });
    const lo = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "noips", password: "pw" }) });
    const denied = await jf(`${base}/api/players/${alpha.id}/ips`, { headers: { authorization: `Bearer ${lo.body.token}` } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.missing?.capability, "player.ips");

    // Re-running the transform never multiplies rows — sightings widen in place.
    await applyArchive(base, id, auth);
    const again = await jf(`${base}/api/players/${alpha.id}/ips`, { headers: auth });
    assert.equal((again.body.ips as unknown[]).length, (r.body.ips as unknown[]).length);
  });
});

test("archive completeness: EVERY pull data type lands somewhere when applied", async () => {
  // The guard against "we pulled it but forgot to apply it": one record of every dataType the
  // worker's pull stages write (runner.ts STAGE_KEYS — keep in sync), pushed through the
  // transform, each asserted in its destination system. A new pull stage without transform
  // handling shows up here as a missing assertion, not as a silent gap someone finds months later.
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "all", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const T = (n: number) => `2021-01-01T00:0${n}:00Z`; // pre-cutoff era

    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      { dataType: "player", entityKey: "222", raw: { player_id: "222", name: "Bravo" } },
      { dataType: "vip", entityKey: "111", raw: { player_id: "111", name: "Alpha", vip_expiration: "never" } },
      { dataType: "ban", entityKey: "b1", raw: { player_id: "222", type: "perma", reason: "cheating", admin_name: "A" } },
      { dataType: "blacklist", entityKey: "9", raw: { id: "9", name: "Cheaters" } },
      { dataType: "blacklist_record", entityKey: "r1", raw: { id: "r1", blacklist_id: "9", player_id: "222", reason: "aimbot" } },
      { dataType: "standard_message", entityKey: "m1", raw: { kind: "broadcast", message: "hello world" } },
      { dataType: "map_history", entityKey: "mh1", raw: { id: "mh1", name: "carentan_warfare", start: T(0), end: T(9) } },
      { dataType: "watchlist", entityKey: "222", raw: { player_id: "222", name: "Bravo", is_watched: true } },
      { dataType: "map_scoreboard", entityKey: "mh1", raw: { id: "mh1", map_name: "carentan_warfare", start: T(0), end: T(9), result: { allied: 4, axis: 1 }, player_stats: [
        { player_id: "111", player: "Alpha", kills: 7, deaths: 2, teamkills: 0, combat: 250, offense: 100, defense: 60, support: 30, vehicle_kills: 1, vehicles_destroyed: 0, time_seconds: 540, team: { side: "allied" },
          units: [{ ts: 1000, team: 1, squad: 0, role: 5 }, { ts: 1300, team: 1, squad: 0, role: 7 }] },
        { player_id: "222", player: "Bravo", kills: 2, deaths: 7, teamkills: 0, combat: 90, offense: 10, defense: 40, support: 5, vehicle_kills: 0, vehicles_destroyed: 0, time_seconds: 480, team: { side: "axis" } },
      ] } },
      // A scoreboard for a round restarted a minute in: not a game, never a match.
      { dataType: "map_scoreboard", entityKey: "short1", raw: { id: "short1", map_name: "foy_warfare", start: "2021-01-01T00:20:00Z", end: "2021-01-01T00:21:00Z", result: { allied: 0, axis: 5 }, player_stats: [
        { player_id: "111", player: "Alpha", kills: 1, deaths: 0, teamkills: 0, combat: 900, offense: 0, defense: 0, support: 0, vehicle_kills: 0, vehicles_destroyed: 0, time_seconds: 60, team: { side: "allied" } },
      ] } },
      { dataType: "player_detail", entityKey: "111", raw: { player_id: "111", name: "Alpha", flags: [{ flag: "🎯" }], comments: [{ content: "note", by: "adm" }], sessions: [{ start: T(1), end: T(2) }], ip_addresses: [{ ip: "89.10.11.12", last_seen: T(1) }] } },
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", action: "KILL", event_time: T(3), player1_id: "111", player1_name: "Alpha", player2_id: "222", player2_name: "Bravo", weapon: "M1 GARAND" } },
      { dataType: "log_teamkill", entityKey: "tk1", raw: { id: "tk1", action: "TEAM KILL", event_time: T(4), player1_id: "111", player1_name: "Alpha", player2_id: "222", player2_name: "Bravo", weapon: "M1 GARAND" } },
      { dataType: "log_match", entityKey: "ms1", raw: { id: "ms1", action: "MATCH START", event_time: T(0), content: "MATCH START CARENTAN Warfare" } },
      { dataType: "log_connect", entityKey: "c1", raw: { id: "c1", action: "CONNECTED", event_time: T(1), player1_id: "111", player1_name: "Alpha", content: "CONNECTED Alpha (111)" } },
      { dataType: "log_disconnect", entityKey: "d1", raw: { id: "d1", action: "DISCONNECTED", event_time: T(5), player1_id: "111", player1_name: "Alpha", content: "DISCONNECTED Alpha (111)" } },
      { dataType: "log_teamswitch", entityKey: "ts1", raw: { id: "ts1", action: "TEAMSWITCH", event_time: T(2), player1_name: "Alpha", content: "TEAMSWITCH Alpha (Axis > Allies)" } },
      { dataType: "log_admin", entityKey: "a1", raw: { id: "a1", action: "ADMIN KICKED", event_time: T(6), player1_name: "Bravo", content: "ADMIN KICKED Bravo", sub_content: "tk at spawn" } },
      { dataType: "log_message", entityKey: "msg1", raw: { id: "msg1", action: "MESSAGE", event_time: T(6), player1_id: "222", player1_name: "Bravo", content: "MESSAGE", sub_content: "stop that" } },
      { dataType: "log_vote", entityKey: "v1", raw: { id: "v1", action: "VOTE STARTED", event_time: T(7), player1_name: "Alpha", content: "VOTE STARTED", sub_content: "kick Bravo" } },
      { dataType: "log_tkauto", entityKey: "ta1", raw: { id: "ta1", action: "TK AUTO BANNED", event_time: T(7), player1_name: "Bravo", content: "TK AUTO BANNED", sub_content: "auto tk" } },
      { dataType: "log_camera", entityKey: "cam1", raw: { id: "cam1", action: "CAMERA", event_time: T(8), player1_name: "AdminJoe", content: "CAMERA", sub_content: "watching" } },
      { dataType: "log_chat", entityKey: "ch1", raw: { id: "ch1", action: "CHAT[Team]", event_time: T(8), player1_id: "111", player1_name: "Alpha", content: "gg", sub_content: "gg" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);

    // Summary: every applied family reports work done.
    for (const [key, want] of Object.entries({ players: 2, vips: 1, bans: 1, watchlist: 1, messages: 1, notes: 1, tags: 1, sessions: 1, ips: 1, kills: 1, teamkills: 1, visits: 1 })) {
      assert.ok((t.body[key] as number) >= want, `summary.${key} >= ${want} (got ${t.body[key]})`);
    }
    assert.ok((t.body.matches as number) >= 1, "map_history and/or log_match produced a match");
    assert.ok((t.body.scoreboards as number) >= 1, "map_scoreboard applied a round's full record");
    assert.ok(!(await repo.matches.list(id, 100)).some((m) => m.map === "foy_warfare"), "the one-minute round's scoreboard made no match");
    assert.ok((t.body.events as number) >= 10, `all log families stored events (got ${t.body.events})`);

    // Destinations: stats on the right player, and every log family's event kind present.
    const alpha = (await repo.players.findByPlatformId("111"))!;
    const stats = await repo.stats.get(alpha.id);
    assert.equal(stats?.kills, 1);
    assert.equal(stats?.teamkills, 1);
    assert.equal(stats?.visits, 1);
    const kinds = new Set((await repo.events.listRecent(id, 100)).map((e) => e.kind));
    for (const k of ["evt.kill", "evt.teamkill", "evt.match.started", "evt.player.connected", "evt.player.disconnected",
                     "evt.player.teamSwitched", "evt.player.kicked", "evt.admin.message", "evt.vote.started",
                     "evt.player.banned", "evt.admin.camera", "evt.chat.team"]) {
      assert.ok(kinds.has(k), `event kind ${k} landed`);
    }
    // A team switch keeps its teams, as the live parser keeps them.
    const sw = (await repo.events.listRecent(id, 100)).find((e) => e.kind === "evt.player.teamSwitched");
    assert.deepEqual(sw?.data, { from: "Axis", to: "Allies", swapFrom: "Axis", swapCount: 1, change: "switched sides Axis → Allies" });

    // The scoreboard's destination: the imported round got its final score, and Alpha's line
    // carries the buckets and playtime no log line could have provided.
    const round = (await repo.matches.list(id)).find((m) => m.startedAt === new Date(T(0)).toISOString());
    assert.ok(round, "the scoreboard's round exists");
    assert.deepEqual([round!.alliedScore, round!.axisScore, round!.winner], [4, 1, "allies"]);
    const line = (await repo.matches.statsForMatch(round!.id)).find((l) => l.playerId === alpha.id);
    assert.ok(line, "Alpha's scoreboard line landed");
    assert.deepEqual([line!.kills, line!.combat, line!.support, line!.side], [7, 250, 30, "allies"]);
    // Alpha's line carried a unit history, so the round gets REAL role clocks (game role ints):
    // 300s as role 5, then the round's remaining 240s as role 7 — not the "-1" sentinel.
    assert.deepEqual(line!.roleSeconds, { "5": 300, "7": 240 }, "unit history becomes real role time");
    // Bravo's line had no unit history — playtime falls back to the unknown-role sentinel.
    const bravo = await repo.players.findByPlatformId("222");
    const bline = (await repo.matches.statsForMatch(round!.id)).find((l) => l.playerId === bravo!.id);
    assert.equal(bline!.roleSeconds["-1"], 480, "no unit history → the sentinel, as before");
  });
});

/*
 * The multi-server story, end to end. CRCON installs share one log store across every server;
 * an archive therefore declares WHICH server it was pulled for (the meta record), the apply pass
 * drops rows naming any other server, contamination from the era before that is detectable
 * (the same CRCON row applied under two servers), and the reset removes an import wholesale so a
 * clean archive rebuilds it. This is the "one and done" contract: not one perfect shot, but a
 * state every re-run converges to.
 */
test("multi-server: other-server rows are dropped, contamination is detected, reset + re-apply converges", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const T = (n: number) => `2021-03-01T00:0${n}:00Z`;
    const mk = async (name: string) => {
      const r = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) });
      return r.body.server.id as string;
    };
    const A = await mk("one"), B = await mk("two");

    // Server A's archive, pulled WITH the meta stage: it knows it is server 1, and (as a real
    // unfiltered-era archive would) it still contains server 2's rows. They must not apply.
    const archiveA = [
      { dataType: "meta", entityKey: "server_number", raw: { server_number: 1 } },
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", action: "KILL", event_time: T(1), server: "1", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      { dataType: "log_kill", entityKey: "k2", raw: { id: "k2", action: "KILL", event_time: T(2), server: "2", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      { dataType: "map_scoreboard", entityKey: "sb2", raw: { id: "sb2", map_name: "foy_warfare", start: T(0), end: T(9), server_number: 2, result: { allied: 1, axis: 0 }, player_stats: [] } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${A}/import/crcon/upload`, { method: "POST", headers: auth, body: archiveA });
    const tA = await applyArchive(base, A, auth);
    assert.equal(tA.status, 200);
    assert.equal(tA.body.kills, 1, "only server 1's kill applied");
    assert.equal(tA.body.skipped.otherServer, 2, "server 2's kill and scoreboard were dropped, not imported");
    assert.equal((await repo.matches.list(A)).length, 0, "server 2's round never landed here");
    const alpha = (await repo.players.findByPlatformId("111"))!;
    assert.equal((await repo.stats.get(alpha.id, A))?.kills, 1);

    // A legacy archive — the network-API era, no meta record — is REFUSED here, because with two
    // servers in the panel there is no way to tell its rows apart and every foreign row would land
    // as this server's history. Refused means refused: an error back, and nothing written.
    const legacy = [
      { dataType: "player", entityKey: "999", raw: { player_id: "999", name: "Legacy" } },
      { dataType: "log_kill", entityKey: "kx", raw: { id: "kx", action: "KILL", event_time: T(3), server: "1", player1_id: "999", player1_name: "Legacy", player2_id: "999", player2_name: "Legacy", weapon: "W" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${B}/import/crcon/upload`, { method: "POST", headers: auth, body: legacy });
    const refused = await applyArchive(base, B, auth);
    assert.equal(refused.status, 200);
    assert.equal(refused.body.kills, 0, "not one row of an unattributable archive applied");
    assert.match((refused.body.errors as string[]).join(" "), /predates the database export/, "and the reason says what to do about it");
    assert.equal(await repo.players.findByPlatformId("999"), null, "the refusal happened before any write");

    // Contamination still has one road in, by design: a row that names NO server is taken as the
    // archive's own, since the filter exists to drop the other server's rows, not to demand
    // paperwork from formats that never carried any. Server B's archive knows it is server 2 and
    // carries the same CRCON row k1 with no server field — so both servers now hold crcon:k1,
    // which is exactly the fingerprint the integrity check exists to find.
    const archiveB = [
      { dataType: "meta", entityKey: "server_number", raw: { server_number: 2 } },
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", action: "KILL", event_time: T(1), player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${B}/import/crcon/upload`, { method: "POST", headers: auth, body: archiveB });
    await applyArchive(base, B, auth);

    const dirty = await jf(`${base}/api/servers/${A}/import/crcon/integrity`, { headers: auth });
    assert.equal(dirty.status, 200);
    assert.equal(dirty.body.importedEvents, 1);
    assert.equal(dirty.body.crossServerEvents, 1, "the same CRCON row on two servers is the contamination fingerprint");

    // The repair: reset A's imported era. Careers recount from what remains (nothing live here).
    const reset = await jf(`${base}/api/servers/${A}/import/crcon/reset`, { method: "POST", headers: auth });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.events, 1);
    assert.equal((await repo.stats.get(alpha.id, A))?.kills ?? 0, 0, "career kills recounted to live evidence (none)");
    assert.equal((await jf(`${base}/api/servers/${A}/import/crcon/integrity`, { headers: auth })).body.importedEvents, 0);

    // Convergence: re-applying the SAME archive rebuilds exactly what it describes.
    const again = await applyArchive(base, A, auth);
    assert.equal(again.body.kills, 1);
    assert.equal((await repo.stats.get(alpha.id, A))?.kills, 1, "the rebuild counted once — not zero, not double");

    // And resetting B clears the last cross-server copy.
    await jf(`${base}/api/servers/${B}/import/crcon/reset`, { method: "POST", headers: auth });
    assert.equal((await jf(`${base}/api/servers/${A}/import/crcon/integrity`, { headers: auth })).body.crossServerEvents, 0);

    // The destructive route is permission-gated like every other import write.
    assert.equal((await jf(`${base}/api/servers/${A}/import/crcon/reset`, { method: "POST" })).status, 401);
  });
});

/*
 * The dry run: the whole archive through the real transform into a throwaway store. The full
 * report — with the same cutoff behaviour as the real Apply — and zero writes. This is the
 * fire-once safety: nothing touches the database until the report has been read clean.
 */
test("dry run: full parse report, identical cutoff behaviour, and not one row written", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dry", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // A local event sets a real cutoff — the dry run must honour it exactly.
    await repo.events.insert([{ serverId: id, ts: "2026-01-01T00:00:00.000Z", kind: "evt.kill", actorPlayerId: null, actorName: "L", victimPlayerId: null, victimName: "M", weapon: "X", data: null, dedupeKey: "local-1" }]);

    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      { dataType: "log_kill", entityKey: "k1", raw: { id: "k1", action: "KILL", event_time: "2021-01-01T00:00:00Z", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      { dataType: "log_kill", entityKey: "k-late", raw: { id: "k-late", action: "KILL", event_time: "2026-06-01T00:00:00Z", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      { dataType: "log_kill", entityKey: "k-junk", raw: { id: "k-junk", action: "KILL", event_time: "2021-02-01T00:00:00Z", someone: "?" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const dry = await applyArchive(base, id, auth, true);
    assert.equal(dry.status, 200);
    // The report is complete: what would land, what would skip, and why.
    assert.equal(dry.body.kills, 1, "reports the one importable kill");
    assert.equal(dry.body.cutoff, "2026-01-01T00:00:00.000Z", "the throwaway store was seeded with the REAL cutoff");
    assert.equal(dry.body.skipped.afterCutoff, 1, "the live-era row skips exactly as a real Apply would skip it");
    assert.equal(dry.body.skipped.unrecognized, 1, "parse problems surface in the dry run — before any write");

    // And the real store is untouched: no player, no events beyond the local one, no career.
    assert.equal(await repo.players.findByPlatformId("111"), null, "no player row was written");
    assert.equal((await repo.crconSnapshot.importIntegrity(id)).importedEvents, 0, "no imported events were written");

    // The same archive then applies for real, unaffected by the dry run having happened.
    const real = await applyArchive(base, id, auth);
    assert.equal(real.body.kills, 1);
    const alpha = await repo.players.findByPlatformId("111");
    assert.ok(alpha, "the real Apply writes what the dry run only reported");
    assert.equal((await repo.stats.get(alpha!.id, id))?.kills, 1);
  });
});

test("backfill skip report: cutoff skips are counted and unrecognized rows produce samples", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "diag", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // The panel started watching this server at T — a locally-ingested event sets the cutoff.
    await repo.events.insert([{ serverId: id, ts: "2026-01-01T00:00:00.000Z", kind: "evt.kill", actorPlayerId: null, actorName: "L", victimPlayerId: null, victimName: "M", weapon: "X", data: null, dedupeKey: "local-1" }]);

    const ndjson = [
      { dataType: "player", entityKey: "111", raw: { player_id: "111", name: "Alpha" } },
      // Before the cutoff → applies.
      { dataType: "log_kill", entityKey: "k-old", raw: { id: "k-old", action: "KILL", event_time: "2021-01-01T00:00:00Z", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      // After the cutoff → skipped BY DESIGN (the live record owns that era), and counted as such.
      { dataType: "log_kill", entityKey: "k-new", raw: { id: "k-new", action: "KILL", event_time: "2026-06-01T00:00:00Z", player1_id: "111", player1_name: "Alpha", player2_id: "111", player2_name: "Alpha", weapon: "W" } },
      // No usable ids at all (field-name drift) → unrecognized, with a sample for the panel.
      { dataType: "log_kill", entityKey: "k-junk", raw: { id: "k-junk", action: "KILL", event_time: "2021-02-01T00:00:00Z", someone: "Alpha", other: "Bravo" } },
      // No readable timestamp → its own bucket.
      { dataType: "log_kill", entityKey: "k-nots", raw: { id: "k-nots", action: "KILL", player1_id: "111" } },
    ].map((r) => JSON.stringify(r)).join("\n");
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });

    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);
    assert.equal(t.body.kills, 1); // only the pre-cutoff kill applied
    assert.equal(t.body.cutoff, "2026-01-01T00:00:00.000Z");
    assert.equal(t.body.skipped.afterCutoff, 1);
    assert.equal(t.body.skipped.unrecognized, 1);
    assert.equal(t.body.skipped.noTimestamp, 1);
    assert.ok((t.body.unrecognizedSamples as string[]).some((x) => x.includes("k-junk")), "sample carries the raw row");
  });
});

/*
 * The wipe. Reset removes what an import CLAIMS it wrote, which leaves behind whatever an older
 * import wrote with nothing to recognise it by. This takes the server itself — and the two things
 * that make it safe to reach for are that ANOTHER server keeps everything, and that configuration
 * survives untouched.
 */
test("wipe: this server's data goes, another server's is untouched, and settings survive", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => {
      const r = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) });
      return r.body.server.id as string;
    };
    const doomed = await mk("doomed"), keeper = await mk("keeper");

    // One player on each server, plus a player on BOTH — the one whose records must survive.
    const T = (n: number) => `2021-05-0${n}T00:00:00.000Z`;
    const ev = (serverId: string, pid: string, key: string, ts: string) =>
      repo.events.insert([{ serverId, ts, kind: "evt.kill", actorPlayerId: pid, actorName: "x", victimPlayerId: pid, victimName: "x", weapon: "W", data: null, dedupeKey: key }]);
    const mkPlayer = async (platformId: string) => (await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: platformId })).id;
    const onlyDoomed = await mkPlayer("111"), onBoth = await mkPlayer("222");
    await ev(doomed, onlyDoomed, "d1", T(1));
    await ev(doomed, onBoth, "d2", T(1));
    await ev(keeper, onBoth, "k1", T(2));
    for (const pid of [onlyDoomed, onBoth]) {
      await repo.playerNotes.create({ playerId: pid, authorUserId: null, authorName: "CRCON", body: "note", createdAt: T(1) });
      await repo.playerTags.add({ playerId: pid, label: "tag", note: null, createdByName: "CRCON" });
    }
    await repo.vips.upsert({ serverId: doomed, playerId: "111", playerName: "a", comment: null, expiration: null, createdByUserId: null, createdByName: "CRCON" });
    await repo.vips.upsert({ serverId: keeper, playerId: "222", playerName: "b", comment: null, expiration: null, createdByUserId: null, createdByName: "CRCON" });

    // Configuration that must be standing afterwards.
    const tmpl = await repo.templates.create({ kind: "broadcast", body: "keep me" });

    // No typed confirmation: the permission check is the gate, and a stale panel bundle sending
    // whatever the previous build sent must still work rather than refusing a correct operator.
    const r = await jf(`${base}/api/servers/${doomed}/purge`, { method: "POST", headers: auth, body: JSON.stringify({ confirm: "whatever the old client sent" }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.events, 2);
    assert.equal(r.body.vips, 1);

    // Gone here.
    assert.equal((await repo.events.listRecent(doomed, 10)).length, 0);
    assert.equal((await repo.vips.list(doomed)).length, 0);

    // Untouched there — the whole point. The other server keeps its events and its VIP, and the
    // player who plays on BOTH keeps the notes and tags that are install-wide.
    assert.equal((await repo.events.listRecent(keeper, 10)).length, 1, "the other server's history is not in range");
    assert.equal((await repo.vips.list(keeper)).length, 1, "nor its VIP grants");
    assert.equal((await repo.playerNotes.list(onBoth)).length, 1, "a player still seen elsewhere keeps their notes");
    assert.equal((await repo.playerTags.list(onBoth)).length, 1, "and their tags");
    // The player who existed only here loses the records that now describe nothing.
    assert.equal((await repo.playerNotes.list(onlyDoomed)).length, 0);
    assert.equal((await repo.playerTags.list(onlyDoomed)).length, 0);

    // Identity survives on both, so Discord links and balances hanging off it do too.
    assert.ok(await repo.players.findByPlatformId("111"), "players are identities, not history");
    assert.ok(await repo.players.findByPlatformId("222"));

    // And no configuration was in range.
    assert.ok((await repo.templates.list()).some((t) => t.id === tmpl.id), "settings are untouched");
    assert.ok(await repo.servers.findById(doomed), "the server itself still exists — its data went, not it");

    assert.equal((await jf(`${base}/api/servers/${doomed}/purge`, { method: "POST" })).status, 401);
  });
});

// The owner's case, in the CRCON era: swaps are a leave and the join after it in the same round,
// and the archive is in file order — so the import reads them through their rounds at the end.
test("crcon transform: imported switches are read through their rounds, whatever order the archive holds them in", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "swaps", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const sw = (key: string, at: string, teams: string, pid = "444") =>
      ({ dataType: "log_teamswitch", entityKey: key, raw: { id: key, event_time: at, type: "TEAMSWITCH", player1_id: pid, player1_name: "Delta", content: `TEAMSWITCH Delta (${teams})` } });
    const ndjson = [
      // Deliberately out of time order.
      sw("s4", "2026-03-02T12:31:00", "Axis > None"),
      sw("s3", "2026-03-02T12:30:00", "None > Axis"),
      sw("s2", "2026-03-02T12:30:00", "Allies > None"),
      { dataType: "log_match", entityKey: "me1", raw: { id: "me1", event_time: "2026-03-02T13:30:00", type: "MATCH ENDED", content: "MATCH ENDED `FOY WARFARE` AXIS (3 - 2)" } },
      sw("s1", "2026-03-02T12:05:00", "None > Allies"),
      { dataType: "log_match", entityKey: "ms1", raw: { id: "ms1", event_time: "2026-03-02T12:00:00", type: "MATCH START", content: "MATCH START FOY WARFARE" } },
      sw("s5", "2026-03-02T12:31:00", "None > Allies"),
      // The next round: his last side was this one's predecessor's, not his.
      { dataType: "log_match", entityKey: "ms2", raw: { id: "ms2", event_time: "2026-03-02T13:35:00", type: "MATCH START", content: "MATCH START CARENTAN WARFARE" } },
      sw("s6", "2026-03-02T13:36:00", "None > Axis"),
    ].map((r) => JSON.stringify(r)).join("\n");
    // An earlier build already imported two of these, without their teams ("switched team").
    const stale = (key: string, at: string) => ({ serverId: id, ts: new Date(`${at}Z`).toISOString(), kind: "evt.player.teamSwitched", actorPlayerId: null, actorName: "Delta", victimPlayerId: null, victimName: null, weapon: null, data: null, dedupeKey: `crcon:${key}` });
    await repo.events.insert([stale("s2", "2026-03-02T12:30:00"), stale("s3", "2026-03-02T12:30:00")]);
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);
    const rows = (await repo.events.listRecent(id, 100)).filter((e) => e.kind === "evt.player.teamSwitched");
    const of = (key: string) => rows.find((e) => e.dedupeKey === `crcon:${key}`)?.data;
    assert.deepEqual(of("s1"), { from: "None", to: "Allies", change: "joined Allies" });
    assert.deepEqual(of("s2"), { from: "Allies", to: "None", change: "left Allies" });
    assert.deepEqual(of("s3"), { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" }, "the earlier import's rows are filled in place");
    assert.deepEqual(of("s4"), { from: "Axis", to: "None", change: "left Axis" }, "same second as the join after it — read first");
    assert.deepEqual(of("s5"), { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2, change: "switched sides Axis → Allies" });
    assert.deepEqual(of("s6"), { from: "None", to: "Axis", change: "joined Axis" }, "a new round starts the count");
    assert.equal(rows.length, 6, "every switch stored, once");
  });
});

// The apply runs in flat memory whatever the archive's size, as this file's header promises: a
// switch is written as the archive streams, like every other line — never held back until the
// end. A multi-year archive carries millions of them, and holding them all as event objects
// pushed an apply that already runs near its heap ceiling over it.
test("crcon transform: team switches are written as the archive streams, and the swap is still named", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "streamed", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const sw = (key: string, at: string, teams: string) =>
      ({ dataType: "log_teamswitch", entityKey: key, raw: { id: key, event_time: at, type: "TEAMSWITCH", player1_id: "555", player1_name: "Echo", content: `TEAMSWITCH Echo (${teams})` } });
    const ndjson = [
      // The swap's two lines open the archive; enough chat follows for several batches to be written.
      sw("w1", "2026-03-03T12:00:00", "Allies > None"),
      sw("w2", "2026-03-03T12:00:01", "None > Axis"),
      ...Array.from({ length: 1200 }, (_, i) => ({ dataType: "log_chat", entityKey: `wc${i}`, raw: { id: `wc${i}`, event_time: "2026-03-03T12:30:00", type: "CHAT[Allies][Team]", player1_id: "555", player1_name: "Echo", sub_content: `line ${i}` } })),
    ].map((r) => JSON.stringify(r)).join("\n");
    // The kinds in each batch the apply writes, in the order it writes them.
    const batches: string[][] = [];
    const insert = repo.events.insert.bind(repo.events);
    repo.events.insert = async (rows) => { batches.push(rows.map((r) => r.kind)); return insert(rows); };
    await jf(`${base}/api/servers/${id}/import/crcon/upload`, { method: "POST", headers: auth, body: ndjson });
    const t = await applyArchive(base, id, auth);
    assert.equal(t.status, 200);
    assert.ok(batches.length >= 3, "the archive was written in several batches");
    assert.ok(batches[0]!.includes("evt.player.teamSwitched"), "the switches went out in the first batch, with the lines around them — not after the whole archive");
    const rows = (await repo.events.listRecent(id, 2000)).filter((e) => e.kind === "evt.player.teamSwitched");
    const of = (key: string) => rows.find((e) => e.dedupeKey === `crcon:${key}`)?.data;
    assert.deepEqual(of("w1"), { from: "Allies", to: "None", change: "left Allies" });
    assert.deepEqual(of("w2"), { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" }, "named once the whole archive was seen");
  });
});
