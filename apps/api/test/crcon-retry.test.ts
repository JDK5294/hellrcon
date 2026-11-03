/**
 * The CRCON pull "retry failures / top up" route: flips a finished job back to running with a
 * surgical cursor reset — failed player profiles queued for the worker's retry stage, failed
 * stages cleared to re-run, everything that succeeded untouched. Never re-pulls a full archive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf } from "./harness.ts";

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("retry route: queues failed profiles, clears failed stages, keeps finished ones", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: "http://crcon", apiKey: "K", createdByName: "owner" });
    await repo.crconSnapshot.updateJob(job.id, {
      status: "done",
      cursor: { vip: { done: true }, player: { page: 9, done: true }, log_camera: { done: true }, standard_message: { done: true } },
      errors: [
        "player_profile 76561198000000001: CRCON returned 500 for get_player_profile",
        "player_profile 76561198000000002: CRCON returned 502 for get_player_profile",
        "player_profile 76561198000000001: CRCON returned 500 for get_player_profile", // repeat → deduped
        "log_camera: CRCON returned 404 for get_historical_logs",
        "get_standard_welcome_messages: boom",
      ],
    });

    const r = await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.retriedProfiles, 2);
    const j = r.body.job;
    assert.equal(j.status, "running");
    assert.deepEqual(j.errors, []);
    assert.deepEqual(j.cursor.player_detail_retry.pids.sort(), ["76561198000000001", "76561198000000002"]);
    assert.equal(j.cursor.log_camera, undefined);        // failed stage re-runs
    assert.equal(j.cursor.standard_message, undefined);  // get_standard_* failure re-runs the messages stage
    assert.equal(j.cursor.vip.done, true);               // untouched success stays done
    assert.equal(j.cursor.player.done, true);
  });
});

test("retry route gates: running/paused/none refused; permission required", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "pleb", password: "pw" }) });
    const pleb = await login(base, "pleb", "pw");
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });

    assert.equal((await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: owner })).status, 404);
    const job = await repo.crconSnapshot.createJob({ serverId: srv.id, baseUrl: "http://crcon", apiKey: "K", createdByName: "owner" });
    assert.equal((await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: owner })).status, 400); // running
    await repo.crconSnapshot.updateJob(job.id, { status: "paused" });
    assert.equal((await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: owner })).status, 400); // paused → Resume
    await repo.crconSnapshot.updateJob(job.id, { status: "done" });
    assert.equal((await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: pleb })).status, 403);
    assert.equal((await jf(`${base}/api/servers/${srv.id}/import/crcon/job/retry`, { method: "POST", headers: owner })).status, 200); // done + no errors = pure top-up
  });
});
