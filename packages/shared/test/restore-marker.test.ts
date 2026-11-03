/**
 * The restore marker: the file-based "stand down" signal between a restore and the worker.
 * Freshness is the truth — a wreck's stale marker must not silence ingestion forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armRestoreMarker, clearRestoreMarker, restoreInProgress, restoreMarkerPath, backupDirPath } from "../dist/restore-marker.js";

function scratchEnv(): { env: NodeJS.ProcessEnv; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "restore-marker-"));
  return { env: { BACKUP_DIR: join(dir, "not-created-yet") }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("armed means in progress; cleared means not; absent means not", () => {
  const { env, done } = scratchEnv();
  try {
    assert.equal(restoreInProgress(env), false, "no marker, no restore");
    armRestoreMarker(env); // the directory did not exist — arming creates it
    assert.equal(restoreInProgress(env), true);
    clearRestoreMarker(env);
    assert.equal(restoreInProgress(env), false);
    clearRestoreMarker(env); // clearing twice is a no-op, not a throw
  } finally { done(); }
});

test("a stale marker is a wreck, not a restore — and re-arming freshens it", () => {
  const { env, done } = scratchEnv();
  try {
    armRestoreMarker(env);
    const old = (Date.now() - 60 * 60_000) / 1000; // an hour ago, well past any max age
    utimesSync(restoreMarkerPath(env), old, old);
    assert.equal(restoreInProgress(env), false, "an hour-old marker is ignored");
    armRestoreMarker(env); // the refresh path a long-running import uses
    assert.equal(restoreInProgress(env), true);
  } finally { done(); }
});

test("the marker lives where backups live, under the same BACKUP_DIR override", () => {
  const { env, done } = scratchEnv();
  try {
    assert.ok(restoreMarkerPath(env).startsWith(backupDirPath(env)));
    assert.equal(backupDirPath({}), "/data/backups", "the default is the mounted folder both processes share");
  } finally { done(); }
});
