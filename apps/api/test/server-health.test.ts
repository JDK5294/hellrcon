/**
 * Whether the panel remembers that a server does not answer.
 *
 * The incident this comes from: a host rotated one server's RCON password, every operation against
 * that server failed authentication from that moment, and the app discarded every one of those
 * failures. The Connections screen showed it ACTIVE beside two healthy servers for days. The only
 * trace was a WARN line in a container log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";

test("a failure is remembered, with its reason, and cleared by the next success", async () => {
  const repo = await createRepository();
  const s = await repo.servers.create({ name: "Second", host: "10.0.0.2", port: 27230, password: "stale" });
  assert.equal(s.lastContactAt, null, "a new server has no contact history to report");
  assert.equal(s.lastError, null);

  // The 401 that ran for days.
  await repo.servers.recordContact(s.id, { ok: false, error: "(401) Unable to perform request. Missing authentication credentials." });
  const failing = (await repo.servers.findById(s.id))!;
  assert.match(failing.lastError!, /401/, "the server's own words, which name the fix");
  assert.ok(failing.lastErrorAt, "and when it happened");
  assert.equal(failing.lastContactAt, null, "it has never answered");

  // Staff fix the password; the next dial succeeds.
  await repo.servers.recordContact(s.id, { ok: true });
  const healthy = (await repo.servers.findById(s.id))!;
  assert.equal(healthy.lastError, null, "a success clears the error rather than leaving a stale alarm");
  assert.equal(healthy.lastErrorAt, null);
  assert.ok(healthy.lastContactAt, "and records that it answered");
});

test("repeated successes do not write on every poll", async () => {
  const repo = await createRepository();
  const s = await repo.servers.create({ name: "Busy", host: "10.0.0.1", port: 28865, password: "x" });
  await repo.servers.recordContact(s.id, { ok: true });
  const first = (await repo.servers.findById(s.id))!.lastContactAt;

  // The ingestion loop connects every few seconds per server. Writing a row per poll would be pure
  // amplification for a timestamp nobody reads to the second.
  await repo.servers.recordContact(s.id, { ok: true });
  assert.equal((await repo.servers.findById(s.id))!.lastContactAt, first, "throttled");

  // But a success that CLEARS an error always writes — that transition is the one staff wait for.
  await repo.servers.recordContact(s.id, { ok: false, error: "connection refused" });
  await repo.servers.recordContact(s.id, { ok: true });
  const recovered = (await repo.servers.findById(s.id))!;
  // Asserted through the cleared error rather than a moved timestamp: both writes can land in the
  // same millisecond, so comparing clocks would test the machine's speed instead of the rule.
  // Clearing the error is something only the write does.
  assert.equal(recovered.lastError, null, "recovery is never throttled away");
  assert.equal(recovered.lastErrorAt, null);
});

test("the error is bounded — an upstream stack cannot flood the column a UI renders", async () => {
  const repo = await createRepository();
  const s = await repo.servers.create({ name: "Loud", host: "10.0.0.3", port: 28865, password: "x" });
  await repo.servers.recordContact(s.id, { ok: false, error: "x".repeat(5000) });
  assert.equal((await repo.servers.findById(s.id))!.lastError!.length, 500);
});

test("health never leaks the password, and rides on the public server shape", async () => {
  const repo = await createRepository();
  const s = await repo.servers.create({ name: "Pub", host: "10.0.0.4", port: 28865, password: "secret" });
  await repo.servers.recordContact(s.id, { ok: false, error: "nope" });
  const { toPublicServer } = await import("@app/db");
  const pub = toPublicServer((await repo.servers.findById(s.id))!) as Record<string, unknown>;
  assert.equal(pub.password, undefined);
  assert.equal(pub.lastError, "nope", "the panel can read it without a second request");
});
