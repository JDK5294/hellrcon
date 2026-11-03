import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

/*
 * Telling players an admin is watching is a POLICY choice, so it is off until somebody turns it on
 * — and a switch that is on with nothing to say would be a setting that silently does nothing.
 */
test("admin camera notification: off by default, round-trips, and refuses to be on and silent", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Warfare", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // An unconfigured server answers with the defaults rather than null: "never set" and "set to
    // the defaults" are the same state, and the editor needs something to render either way.
    const first = await jf(`${base}/api/servers/${id}/admincam/config`, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.body.notifyEnabled, false);
    // {player}, not {admin}: this name comes off the game log, so it is the IN-GAME one. The
    // panel/Discord name lives behind {staff} on signatures, and the two must not look alike.
    assert.match(first.body.enterMessage, /\{player\}/);
    assert.doesNotMatch(first.body.enterMessage, /\{admin\}/);
    assert.equal(first.body.exitMessage, "", "the exit is silent unless somebody asks for it");

    const on = await jf(`${base}/api/servers/${id}/admincam/config`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ notifyEnabled: true, enterMessage: "{player} is watching", exitMessage: "" }),
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.notifyEnabled, true);
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/config`, { headers: auth })).body.enterMessage, "{player} is watching");

    // On, with both halves blank, is a toggle that does nothing — and would look like a bug later.
    const mute = await jf(`${base}/api/servers/${id}/admincam/config`, {
      method: "PUT", headers: auth, body: JSON.stringify({ notifyEnabled: true, enterMessage: "", exitMessage: "" }),
    });
    assert.equal(mute.status, 400);
    assert.match(mute.body.error.message, /at least one/);

    // The change is a change to the server, so it is on the trail.
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "admincam.config"));

    // Reading needs the console-admin capability; the whole page is gated on it.
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/config`)).status, 401);
  });
});

/*
 * The history is the point: spectator leaves no audit row, so this table IS the record. It has to
 * answer "who, where, when, how long" across every server the viewer can see, sorted the way they
 * asked — SERVER-side, because sorting one page of a paged list by duration answers a different
 * question from the one being asked.
 */
test("admin camera history: paired sessions, filtered by server and admin, sorted in the store", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string, port: number) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const a = await mk("Warfare", 1);
    const b = await mk("Offensive", 2);

    const jane = await repo.players.upsert({ game: "hll", platformId: "76561190000000501", name: "Jane", platform: "steam" });
    const bo = await repo.players.upsert({ game: "hll", platformId: "76561190000000502", name: "Bo", platform: "steam" });
    const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

    // Jane: a short visit on Warfare, then a long one on Offensive. Bo: still in cam.
    await repo.adminCam.open({ serverId: a, playerId: jane.id, playerName: "Jane", at: T(0) });
    await repo.adminCam.close({ serverId: a, playerId: jane.id, playerName: "Jane", at: T(5) });
    await repo.adminCam.open({ serverId: b, playerId: jane.id, playerName: "Jane", at: T(10) });
    await repo.adminCam.close({ serverId: b, playerId: jane.id, playerName: "Jane", at: T(40) });
    await repo.adminCam.open({ serverId: a, playerId: bo.id, playerName: "Bo", at: T(50) });

    const all = await jf(`${base}/api/admincam/history`, { headers: auth });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 3);
    // Newest first by default, and the server's NAME comes resolved so the page never has to guess.
    assert.equal(all.body.sessions[0].playerName, "Bo");
    assert.equal(all.body.sessions[0].serverName, "Warfare");
    // Bo has not left: no exit and no duration is a live reading, not a broken row.
    assert.equal(all.body.sessions[0].exitedAt, null);
    assert.equal(all.body.sessions[0].durationSec, null);
    // Both filter dropdowns are built from the record itself — you appear only if you were in cam.
    assert.deepEqual((all.body.admins as any[]).map((x) => x.playerName).sort(), ["Bo", "Jane"]);
    assert.deepEqual((all.body.servers as any[]).map((x) => x.name).sort(), ["Offensive", "Warfare"]);

    // Longest first. The open session sorts LAST in both directions rather than as zero seconds.
    const byLength = await jf(`${base}/api/admincam/history?sort=duration&dir=desc`, { headers: auth });
    assert.deepEqual((byLength.body.sessions as any[]).map((s) => s.durationSec), [1800, 300, null]);
    const shortest = await jf(`${base}/api/admincam/history?sort=duration&dir=asc`, { headers: auth });
    assert.deepEqual((shortest.body.sessions as any[]).map((s) => s.durationSec), [300, 1800, null]);

    // By admin, A-Z, and by server name — the two the page offers as headers.
    const byWho = await jf(`${base}/api/admincam/history?sort=who&dir=asc`, { headers: auth });
    assert.equal((byWho.body.sessions as any[])[0].playerName, "Bo");
    const byServer = await jf(`${base}/api/admincam/history?sort=server&dir=asc`, { headers: auth });
    assert.equal((byServer.body.sessions as any[])[0].serverName, "Offensive");

    // Narrowing on either axis.
    assert.equal((await jf(`${base}/api/admincam/history?serverId=${b}`, { headers: auth })).body.total, 1);
    assert.equal((await jf(`${base}/api/admincam/history?playerId=${jane.id}`, { headers: auth })).body.total, 2);

    // Paged like every other long list, and the total describes the whole set, not the page.
    const page = await jf(`${base}/api/admincam/history?limit=2`, { headers: auth });
    assert.equal((page.body.sessions as any[]).length, 2);
    assert.equal(page.body.total, 3);

    // Gated on the console-admin capability: this is a record about the people on that list.
    assert.equal((await jf(`${base}/api/admincam/history`)).status, 401);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/admincam/history`, { headers: plain })).status, 403);
  });
});

/*
 * The self-check exists because this subsystem's only failure mode is silence: an empty table
 * looks the same whether the game never printed a camera line, the poll missed it, the parser
 * failed on it, or the pairing dropped it. So the important property is that the check REPORTS a
 * broken link instead of failing on it — a diagnostic that 500s when the thing it diagnoses is
 * down diagnoses nothing.
 */
test("admin camera self-check reports a broken link rather than failing on it", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    // Port 1 answers nothing, which is exactly the case: the log read cannot happen.
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Warfare", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const out = await jf(`${base}/api/servers/${id}/admincam/selfcheck`, { headers: auth });
    assert.equal(out.status, 200, "an unreachable server is a finding, not a 500");
    assert.equal(out.body.read.ok, false);
    assert.ok(String(out.body.read.error).length > 0, "and it says what went wrong");

    // The switch is reported separately from the record, because "no in-game announcements" and
    // "no history" have different causes and the page conflated them.
    assert.equal(out.body.notify.enabled, false);
    assert.equal(out.body.engagementMode, "observe");
    assert.equal(out.body.stored.events, 0);
    assert.equal(out.body.stored.visits, 0);

    // Turning the switch on is visible here — this is the answer to "why is nobody being told".
    await jf(`${base}/api/servers/${id}/admincam/config`, {
      method: "PUT", headers: auth, body: JSON.stringify({ notifyEnabled: true, enterMessage: "{player} is watching" }),
    });
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/selfcheck`, { headers: auth })).body.notify.enabled, true);

    // Stored visits are counted, so "the game says it but nothing is kept" is distinguishable
    // from "the game never said it".
    await repo.adminCam.importOne({
      serverId: id, playerId: null, playerName: "Jane",
      enteredAt: new Date(Date.now() - 600_000).toISOString(), exitedAt: new Date().toISOString(), durationSec: 600,
    });
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/selfcheck`, { headers: auth })).body.stored.visits, 1);

    // Same grant as the history it diagnoses.
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/selfcheck`)).status, 401);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain2", password: "pw" }) });
    assert.equal((await jf(`${base}/api/servers/${id}/admincam/selfcheck`, { headers: { authorization: `Bearer ${l.body.token as string}` } })).status, 403);
  });
});
