/*
 * The historical back-builder: CRCON profiles carry timestamped session history and a `created`
 * stamp, and the transform folds them into the career record — playtime for the era before local
 * observation began, and a first-seen that reaches back to when CRCON first met the player rather
 * than the day this panel was installed. Both must be idempotent: applying the same archive twice
 * is the normal workflow (retry a failed pull, re-import after a top-up), not an edge case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryRepository } from "@app/db";
import { crconBackupFile } from "@app/shared";
// Via dist, not src: the transform pulls in sibling modules by their compiled .js names, which the
// type-stripping test runner cannot resolve from the .ts tree.
import { transformCrconArchive } from "../dist/crcon-transform.js";

const PID = "76561198000000042";

function writeArchive(serverId: string, records: unknown[]): void {
  process.env.CRCON_BACKUP_DIR = process.env.CRCON_BACKUP_DIR || mkdtempSync(join(tmpdir(), "crcon-transform-test-"));
  writeFileSync(crconBackupFile(serverId), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const profileRecord = (raw: unknown) => ({ dataType: "player_detail", entityKey: PID, raw });

test("imported sessions fold into career playtime exactly once, and first_seen reaches back", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  // The player is already known to live tracking — met "today", long after the CRCON era.
  const before = await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "Vet" });

  writeArchive(server.id, [profileRecord({
    player_id: PID, name: "Vet",
    created: "2021-03-01T10:00:00Z",
    sessions: [
      { start: "2021-03-01T10:00:00Z", end: "2021-03-01T12:00:00Z" }, // 2h
      { start: "2021-04-05T18:00:00Z", end: "2021-04-05T18:30:00Z" }, // 30m
    ],
  })]);

  const s1 = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s1.sessions, 2);
  assert.equal(s1.playtimeSec, 2 * 3600 + 30 * 60, "both pre-cutoff sessions count (no local observation yet → no cutoff)");
  const stats = await repo.stats.get(before.id, server.id);
  assert.equal(stats?.playtimeSec, 9000, "the rollup carries the imported seconds");
  const after = await repo.players.findById(before.id);
  assert.equal(after?.firstSeen, "2021-03-01T10:00:00.000Z", "first seen reaches back to CRCON's `created`");
  assert.equal(after?.lastSeen, before.lastSeen, "last seen does not regress to the historical era");

  // The same archive again — the normal retry workflow. Nothing may count twice.
  const s2 = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s2.sessions, 0);
  assert.equal(s2.playtimeSec, 0);
  assert.equal((await repo.stats.get(before.id, server.id))?.playtimeSec, 9000, "re-running adds nothing");
});

test("zone-less CRCON session stamps mean UTC, never the host's zone", async () => {
  // CRCON's profile sessions arrive zone-less ("2021-03-01T10:00:00") and mean UTC, but bare
  // Date.parse reads exactly that shape in the HOST's local zone. Run under a non-UTC zone so
  // the shift would actually show: with the bug, every stamp below lands 5-6 hours off.
  const prevTz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const repo = new InMemoryRepository();
    const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
    writeArchive(server.id, [profileRecord({
      player_id: PID, name: "Vet",
      created: "2021-03-01T10:00:00",
      sessions: [{ start: "2021-03-01T10:00:00", end: "2021-03-01T12:00:00" }],
    })]);
    const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
    assert.equal(s.sessions, 1);
    assert.equal(s.playtimeSec, 2 * 3600);
    const player = await repo.players.findByPlatformId(PID);
    const sessions = await repo.sessions.list(player!.id, 10);
    assert.equal(sessions[0]!.connectedAt, "2021-03-01T10:00:00.000Z", "zone-less means UTC — never the host's zone");
    assert.equal(sessions[0]!.disconnectedAt, "2021-03-01T12:00:00.000Z");
    assert.equal(player!.firstSeen, "2021-03-01T10:00:00.000Z", "first_seen backdates from the UTC reading too");
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test("an import is not a sighting: last_seen comes from the record, never from the import clock", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S4", host: "h", port: 4, password: "p" });
  // A veteran the panel has never seen live: their CRCON profile says May 2025, both ways.
  writeArchive(server.id, [
    { dataType: "player", entityKey: PID, raw: { player_id: PID, names: [{ name: "Vet", last_seen: "2025-05-20T09:00:00Z" }] } },
    profileRecord({
      player_id: PID, name: "Vet", created: "2025-05-14T10:00:00Z",
      sessions: [{ start: "2025-05-20T08:00:00Z", end: "2025-05-20T09:00:00Z" }],
    }),
  ]);
  await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  const p = await repo.players.findByPlatformId(PID);
  assert.equal(p?.firstSeen, "2025-05-14T10:00:00.000Z", "first seen is the profile's created stamp");
  assert.equal(p?.lastSeen, "2025-05-20T09:00:00.000Z", "last seen is when CRCON last SAW them — not the import moment");

  // Re-running (the normal retry workflow) still moves nothing.
  await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal((await repo.players.findByPlatformId(PID))?.lastSeen, "2025-05-20T09:00:00.000Z");
});

test("the repair lowers a wrongly bumped last_seen back to the evidence, and leaves live players alone", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S5", host: "h", port: 5, password: "p" });
  // The damage the old import did: a ghost whose last real trace is a 2025 session, stamped as
  // seen "now" by a re-import.
  const ghost = await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "Vet", ts: "2025-05-20T09:00:00.000Z" });
  await repo.sessions.importOne({ playerId: ghost.id, serverId: server.id, connectedAt: "2025-05-20T08:00:00.000Z", disconnectedAt: "2025-05-20T09:00:00.000Z", durationSec: 3600 });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "Vet" }); // the bogus "sighting"
  assert.notEqual((await repo.players.findByPlatformId(PID))?.lastSeen, "2025-05-20T09:00:00.000Z", "precondition: the bump happened");
  // A genuinely live player: their latest event vouches for their last_seen.
  const live = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000777", name: "Live", ts: "2026-08-05T11:00:00.000Z" });
  await repo.events.insert([{ serverId: server.id, ts: "2026-08-05T11:00:00.000Z", kind: "evt.kill", actorPlayerId: live.id, dedupeKey: "local:live1" }]);

  writeArchive(server.id, [profileRecord({ player_id: PID, name: "Vet", created: "2025-05-14T10:00:00Z" })]);
  const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.ok(s.lastSeenRepaired >= 1, "the repair reports what it lowered");
  assert.equal((await repo.players.findByPlatformId(PID))?.lastSeen, "2025-05-20T09:00:00.000Z", "the ghost is back on their real last session");
  assert.equal((await repo.players.findByPlatformId("76561198000000777"))?.lastSeen, "2026-08-05T11:00:00.000Z", "a player with live evidence is untouched");
});

test("a session that ended after local observation began is timeline-only, never career playtime", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S2", host: "h", port: 2, password: "p" });
  // Local observation began at noon: from here on the live tracker measures presence itself.
  await repo.events.insert([{ serverId: server.id, ts: "2026-01-10T12:00:00.000Z", kind: "evt.player.connected", dedupeKey: "local:1" }]);

  writeArchive(server.id, [profileRecord({
    player_id: PID, name: "Vet",
    sessions: [
      { start: "2026-01-10T08:00:00Z", end: "2026-01-10T09:00:00Z" }, // fully before the cutoff → counts
      { start: "2026-01-10T11:30:00Z", end: "2026-01-10T12:30:00Z" }, // straddles it → timeline only
    ],
  })]);

  const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s.sessions, 2, "both land on the profile timeline");
  assert.equal(s.playtimeSec, 3600, "only the fully pre-cutoff hour joins the career rollup");
});

test("sessions imported before playtime folding existed are reconciled into the rollup", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S3", host: "h", port: 3, password: "p" });
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "Vet" });
  // The legacy state: an earlier transform put the sessions on the timeline but folded nothing,
  // and the dedupe now refuses to import them again.
  await repo.sessions.importOne({ playerId: player.id, serverId: server.id, connectedAt: "2022-05-01T10:00:00.000Z", disconnectedAt: "2022-05-01T13:00:00.000Z", durationSec: 3 * 3600 });

  writeArchive(server.id, [profileRecord({
    player_id: PID, name: "Vet",
    sessions: [{ start: "2022-05-01T10:00:00Z", end: "2022-05-01T13:00:00Z" }],
  })]);

  const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s.sessions, 0, "the dedupe still refuses the re-import");
  assert.equal(s.playtimeSec, 0, "so folding-on-insert adds nothing");
  assert.equal(s.playtimeSettled, 1, "the reconciliation raises the rollup instead");
  assert.equal((await repo.stats.get(player.id, server.id))?.playtimeSec, 3 * 3600);

  const again = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(again.playtimeSettled, 0, "already reconciled — nothing to raise");
  assert.equal((await repo.stats.get(player.id, server.id))?.playtimeSec, 3 * 3600, "and nothing counted twice");
});

/*
 * Admin camera visits, rebuilt from the archive's CAMERA lines.
 *
 * The import used to write camera EVENTS and stop there. But the Admin camera page is not a list
 * of events — it is a list of VISITS, each an enter paired with its exit — and that pairing lived
 * only in the live ingest path. So an instance that imported its entire CRCON history got every
 * camera line into the game log and a page that said nobody had ever been in the camera. Both
 * statements were built from the same rows.
 */
const camRecord = (i: number, raw: Record<string, unknown>) => ({ dataType: "log_camera", entityKey: `cam-${i}`, raw });

test("CAMERA lines from the archive become paired admin-camera visits", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });

  writeArchive(server.id, [
    camRecord(1, {
      type: "CAMERA", event_time: "2026-01-02T10:00:00Z",
      player1_id: PID, player1_name: "Mod Jane",
      content: "CAMERA[Mod Jane (76561198000000042)] Entered Admin Camera",
      sub_content: "Entered Admin Camera",
    }),
    camRecord(2, {
      type: "CAMERA", event_time: "2026-01-02T10:07:30Z",
      player1_id: PID, player1_name: "Mod Jane",
      content: "CAMERA[Mod Jane (76561198000000042)] Left Admin Camera",
      sub_content: "Left Admin Camera",
    }),
  ]);

  const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s.cameraSessions, 1, "one enter/leave pair is one visit");

  const rows = await repo.adminCam.list({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.playerName, "Mod Jane");
  assert.equal(rows[0]!.enteredAt, "2026-01-02T10:00:00.000Z");
  assert.equal(rows[0]!.exitedAt, "2026-01-02T10:07:30.000Z");
  assert.equal(rows[0]!.durationSec, 450, "the visit is 7m30s long, not open-ended");
});

test("the archive's camera lines are paired in time order, whatever order they stream in", async () => {
  // The archive is read in whatever order its files sit in, and an enter/leave pair only means
  // anything chronologically. Feeding the exit first must not produce a visit that ends before it
  // starts — or worse, an enter left hanging as "still in the camera".
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  writeArchive(server.id, [
    camRecord(2, { type: "CAMERA", event_time: "2026-01-02T11:05:00Z", player1_id: PID, player1_name: "Mod Jane", sub_content: "Left Admin Camera" }),
    camRecord(1, { type: "CAMERA", event_time: "2026-01-02T11:00:00Z", player1_id: PID, player1_name: "Mod Jane", sub_content: "Entered Admin Camera" }),
  ]);

  await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  const rows = await repo.adminCam.list({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.enteredAt, "2026-01-02T11:00:00.000Z");
  assert.equal(rows[0]!.exitedAt, "2026-01-02T11:05:00.000Z");
});

test("re-applying the archive rebuilds camera visits for a database that imported the events alone", async () => {
  // This is the actual repair path, not a hypothetical: every instance that imported before the
  // pairing existed has the events and no visits, and a re-apply is the only way back. It must
  // also be safe to run twice, because re-applying is the normal retry workflow.
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  writeArchive(server.id, [
    camRecord(1, { type: "CAMERA", event_time: "2026-01-03T09:00:00Z", player1_id: PID, player1_name: "Mod Jane", sub_content: "Entered Admin Camera" }),
    camRecord(2, { type: "CAMERA", event_time: "2026-01-03T09:02:00Z", player1_id: PID, player1_name: "Mod Jane", sub_content: "Left Admin Camera" }),
  ]);

  const first = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(first.cameraSessions, 1);
  // The second run re-reads rows whose EVENTS are already stored — the pairing must still run off
  // them (that is what repairs an old import) without minting a duplicate visit.
  await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal((await repo.adminCam.list({})).length, 1, "a re-apply repairs, it does not duplicate");
});

test("an unreadable camera wording is skipped rather than guessed into a session", async () => {
  // A line we cannot read as enter or leave must not open anything: an invented enter is never
  // closed by the real exit, and the leftover reads as "in the camera right now" forever.
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  writeArchive(server.id, [
    camRecord(1, { type: "CAMERA", event_time: "2026-01-04T09:00:00Z", player1_id: PID, player1_name: "Mod Jane", sub_content: "did something new" }),
  ]);

  const s = await transformCrconArchive(repo, server, { userId: null, name: "tester" });
  assert.equal(s.cameraSessions, 0);
  assert.equal((await repo.adminCam.list({})).length, 0, "an ambiguous line leaves no half-open visit");
  // But it IS still in the game log — an unrecognised wording is a gap in the pairing, not a
  // reason to lose the record that something happened.
  const evts = await repo.events.listRecent(server.id, 50);
  assert.ok(evts.some((e) => e.kind === "evt.admin.camera"), "the event is kept regardless");
});

// The exact rows a real install's Apply reported as unrecognized: CRCON's VOTESYS writes the
// verdict into the action string, and only "VOTE COMPLETED" was enumerated — so "VOTE PASSED"
// (a vote-kick that actually removed someone) and "VOTE EXPIRED" were skipped as unparseable.
// Any VOTE* action is a completion now, with the verdict carried as data.
test("VOTESYS verdict lines are vote completions, not unrecognized rows", async () => {
  const { logEvtKind } = await import("../dist/crcon-transform.js");
  const passed = logEvtKind({
    id: 6325622, action: "VOTE PASSED", event_time: "2025-10-28T02:09:46.000Z", player1_name: "GusBusGames",
    raw: "[2.88 sec (1761617386)] VOTESYS: Vote Kick {GusBusGames} successfully passed. [For: 20/20 - Against: 4]",
    content: "Vote Kick {GusBusGames} successfully passed. [For: 20/20 - Against: 4]",
  });
  assert.equal(passed?.kind, "evt.vote.completed");
  assert.equal(passed?.data?.outcome, "passed");
  const expired = logEvtKind({
    id: 6324334, action: "VOTE EXPIRED", event_time: "2025-10-28T01:51:05.000Z",
    raw: "[1.04 sec (1761616265)] VOTESYS: Vote [1] expired before completion.",
    content: "Vote [1] expired before completion.",
  });
  assert.equal(expired?.kind, "evt.vote.completed");
  assert.equal(expired?.data?.outcome, "expired");
  // The enumerated forms keep meaning exactly what they meant.
  assert.equal(logEvtKind({ action: "VOTE COMPLETED", content: "x" })?.kind, "evt.vote.completed");
  assert.equal(logEvtKind({ action: "VOTE STARTED", content: "x" })?.kind, "evt.vote.started");
  assert.equal(logEvtKind({ action: "VOTE", content: "x" })?.kind, "evt.vote.cast");
});
