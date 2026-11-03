import { test } from "node:test";
import assert from "node:assert/strict";
import { planAutoBackup, autoBackupFileName, autoBackupAtMs, hourInZone, AUTO_BACKUP_NAME } from "../src/auto-backup.ts";

const at = (iso: string) => Date.parse(iso);
const base = { enabled: true, supported: true, hour: 4, keep: 7, timezone: "UTC" };

test("a nightly backup is due once the community clock passes the hour, and only once a day", () => {
  // 03:59 community time: not yet.
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-01T03:59:00Z"), files: [] }).due, false);
  // 04:01: due.
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-01T04:01:00Z"), files: [] }).due, true);
  // A fresh archive from tonight's run: the slot is served — later ticks of the same evening skip.
  const tonight = autoBackupFileName(new Date(at("2026-09-01T04:01:30Z")));
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-01T09:00:00Z"), files: [tonight] }).due, false);
  // Next day, past the hour again: due again.
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-02T04:05:00Z"), files: [tonight] }).due, true);
});

test("the hour is the COMMUNITY's hour, not UTC's", () => {
  // 04:30 in New York is 08:30/09:30 UTC depending on DST — either way, past a 4am NY hour.
  const ny = { ...base, timezone: "America/New_York" };
  assert.equal(hourInZone(at("2026-09-01T08:30:00Z"), "America/New_York"), 4);
  assert.equal(planAutoBackup({ ...ny, nowMs: at("2026-09-01T08:30:00Z"), files: [] }).due, true);
  // …while 04:30 UTC is half past midnight in New York: not due there yet.
  assert.equal(planAutoBackup({ ...ny, nowMs: at("2026-09-01T04:30:00Z"), files: [] }).due, false);
  // An unknown zone falls back to UTC rather than never running.
  assert.equal(planAutoBackup({ ...base, timezone: "Nowhere/Invalid", nowMs: at("2026-09-01T04:30:00Z"), files: [] }).due, true);
});

test("a worker that was down over the hour runs when it returns instead of skipping the day", () => {
  const yesterday = autoBackupFileName(new Date(at("2026-08-31T04:00:10Z")));
  // The worker comes back at 15:00 — eleven hours late, still that day's backup.
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-01T15:00:00Z"), files: [yesterday] }).due, true);
  // …and the late one does not move the next: the day after, it is due at the hour again.
  const late = autoBackupFileName(new Date(at("2026-09-01T15:00:10Z")));
  assert.equal(planAutoBackup({ ...base, nowMs: at("2026-09-02T04:01:00Z"), files: [late] }).due, true);
});

test("set for the small hours, it runs once that day and not again until the next", () => {
  // 03:00: written at 03:00. That evening, twenty hours on and still the same day, it is not due
  // again; the next day it is not due before three, and is at three.
  const three = { ...base, hour: 3 };
  const tonight = autoBackupFileName(new Date(at("2026-09-01T03:00:20Z")));
  assert.equal(planAutoBackup({ ...three, nowMs: at("2026-09-01T23:30:00Z"), files: [tonight] }).due, false);
  assert.equal(planAutoBackup({ ...three, nowMs: at("2026-09-02T02:59:00Z"), files: [tonight] }).due, false);
  assert.equal(planAutoBackup({ ...three, nowMs: at("2026-09-02T03:01:00Z"), files: [tonight] }).due, true);
  // Midnight: once a day, not every twenty hours.
  const midnight = { ...base, hour: 0 };
  const first = autoBackupFileName(new Date(at("2026-09-01T00:00:20Z")));
  assert.equal(planAutoBackup({ ...midnight, nowMs: at("2026-09-01T20:30:00Z"), files: [first] }).due, false);
  assert.equal(planAutoBackup({ ...midnight, nowMs: at("2026-09-02T00:01:00Z"), files: [first] }).due, true);
});

test("the day is the COMMUNITY's day, not UTC's", () => {
  // 01:00 in New York is 05:00 UTC. At 03:30 UTC the next morning it is still 23:30 the evening
  // before in New York — the same day as the backup, so not due; at 01:01 New York's next day, due.
  const ny = { ...base, hour: 1, timezone: "America/New_York" };
  const written = autoBackupFileName(new Date(at("2026-09-01T05:00:20Z")));
  assert.equal(planAutoBackup({ ...ny, nowMs: at("2026-09-02T03:30:00Z"), files: [written] }).due, false);
  assert.equal(planAutoBackup({ ...ny, nowMs: at("2026-09-02T05:01:00Z"), files: [written] }).due, true);
});

test("rotation prunes only automatic archives, oldest first, and leaves the manual ones alone", () => {
  const files = [
    "full-backup-20260810-120000.ndjson.gz",       // manual — made before something risky
    "auto-backup-20260826-040010.ndjson.gz",
    "auto-backup-20260827-040010.ndjson.gz",
    "auto-backup-20260828-040010.ndjson.gz",
    "trim-kills-1724900000000.ndjson.gz",          // a trim archive shares the folder
    "full-backup-20240101-000000.ndjson.gz",       // ancient manual — still not rotation's to take
  ];
  // keep=2, not due: the newest two autos stay, the oldest goes, manuals and trims untouched.
  const idle = planAutoBackup({ ...base, keep: 2, nowMs: at("2026-08-28T03:00:00Z"), files });
  assert.equal(idle.due, false);
  assert.deepEqual(idle.prune, ["auto-backup-20260826-040010.ndjson.gz"]);
  // keep=3 and due: tonight's counts against the budget, so the oldest still goes — the folder
  // holds `keep` at rest, never keep+1.
  const night = planAutoBackup({ ...base, keep: 3, nowMs: at("2026-08-29T04:05:00Z"), files });
  assert.equal(night.due, true);
  assert.deepEqual(night.prune, ["auto-backup-20260826-040010.ndjson.gz"]);
});

test("off, or a store with nothing durable, plans nothing — and never prunes either", () => {
  const files = ["auto-backup-20260801-040000.ndjson.gz", "auto-backup-20260802-040000.ndjson.gz"];
  assert.deepEqual(planAutoBackup({ ...base, enabled: false, keep: 1, nowMs: at("2026-09-01T05:00:00Z"), files }), { due: false, prune: [] });
  assert.deepEqual(planAutoBackup({ ...base, supported: false, keep: 1, nowMs: at("2026-09-01T05:00:00Z"), files }), { due: false, prune: [] });
});

test("names round-trip and the pattern rejects everything that is not an auto archive", () => {
  const name = autoBackupFileName(new Date(at("2026-09-01T04:00:10Z")));
  assert.equal(name, "auto-backup-20260901-040010.ndjson.gz");
  assert.ok(AUTO_BACKUP_NAME.test(name));
  assert.equal(autoBackupAtMs(name), at("2026-09-01T04:00:10Z"));
  for (const bad of ["full-backup-20260901-040010.ndjson.gz", "auto-backup-.ndjson.gz", "auto-backup-20260901-040010.ndjson.gz.tmp", "../auto-backup-20260901-040010.ndjson.gz"]) {
    assert.equal(autoBackupAtMs(bad), null, bad);
  }
});
