/**
 * How far a stranded session may honestly be said to have run.
 *
 * The reaper closes sessions the game never reported the end of. It closed them at the moment it
 * noticed — right to within a tick while the worker is up, and badly wrong after an outage: a
 * worker down from 8pm to 2am closed every session stranded at 8pm as though the player had been
 * there until 2am. Six phantom hours of attendance for an event payout, and of hours played.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reapEndAt } from "../src/session-reap.ts";
import { createIsolatedRepository } from "@app/db";

test("the end is capped at the last time anything observed the server", () => {
  const outageEnded = "2026-08-29T02:00:00.000Z";
  const lastSeen = "2026-08-28T20:00:00.000Z";
  assert.equal(reapEndAt(outageEnded, lastSeen), lastSeen, "six hours nobody watched are not six hours played");
  // Normal running: the previous tick is a minute ago, so the end moves by a minute, not by hours.
  assert.equal(reapEndAt("2026-08-29T02:00:00.000Z", "2026-08-29T01:59:00.000Z"), "2026-08-29T01:59:00.000Z");
  // Nothing has been observed yet and the store had no snapshot to seed from: "now" is all there is.
  assert.equal(reapEndAt(outageEnded, null), outageEnded);
  // A mark somehow ahead of this read never extends the session past now.
  assert.equal(reapEndAt(lastSeen, outageEnded), lastSeen);
});

test("a reaped session never ends before it began", async () => {
  // The cap can land before a session that STARTED inside the blind spot — the log backfill after
  // a restart creates exactly those. Zero length is the honest floor; a negative one is nonsense
  // every consumer would have to defend against.
  const { repo, cleanup } = await createIsolatedRepository();
  try {
    const server = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765", name: "Ghost" });
    await repo.sessions.open(p.id, server.id, "2026-08-28T23:00:00.000Z");
    // Reap with an end BEFORE that start, as the outage cap would produce.
    const closed = await repo.sessions.closeAbsent(server.id, [], "2026-08-29T00:00:00.000Z", "2026-08-28T20:00:00.000Z");
    assert.equal(closed, 1);
    const rows = await repo.sessions.list(p.id, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.durationSec, 0);
    assert.ok(rows[0]!.disconnectedAt >= rows[0]!.connectedAt, `${rows[0]!.disconnectedAt} must not precede ${rows[0]!.connectedAt}`);
  } finally { await cleanup(); }
});
