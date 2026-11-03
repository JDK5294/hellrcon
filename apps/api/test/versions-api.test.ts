/**
 * Version history: rules, and the map vote's map sets and schedules, keep every save — before and
 * after — so an accidental change or delete can be put back from the panel.
 *
 * What staff count on: a save that changed what a record does is listed (switching a rule on or off
 * or filing it is not); putting back an earlier version restores its terms but not its switch;
 * a restore is itself listed, so it can be undone; a deleted record comes back under its own id
 * with its history; and a restore is judged by today's checks, like any save.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

const tag = () => Math.random().toString(36).slice(2, 7);

test("a rule's history: edits listed with before and after; switching and filing are not; an earlier version comes back without its switch", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const t = tag();
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      jf(`${base}/api/enforcer/${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const rule = (await call("rules", { name: `TK ${t}`, eventKind: "evt.teamkill", action: "message", reason: "careful", threshold: 2, windowSec: 60 })).body.rule;
    assert.deepEqual((await call(`rules/${rule.id}/versions`)).body.versions, [], "a new rule has no saves yet");

    assert.equal((await call(`rules/${rule.id}`, { threshold: 3, action: "kick" }, "PATCH")).status, 200);
    assert.equal((await call(`rules/${rule.id}`, { enabled: false }, "PATCH")).status, 200, "switched off");
    const sec = (await call("sections", { name: `Shelf ${t}` })).body.section;
    assert.equal((await call(`rules/${rule.id}`, { sectionId: sec.id }, "PATCH")).status, 200, "filed");
    const versions = (await call(`rules/${rule.id}/versions`)).body.versions as any[];
    assert.equal(versions.length, 1, "only the edit is a save worth listing");
    assert.equal(versions[0].change, "edit");
    assert.equal(versions[0].actorName, "owner");
    assert.equal(versions[0].before.threshold, 2);
    assert.equal(versions[0].before.action, "message");
    assert.equal(versions[0].after.threshold, 3);
    assert.equal(versions[0].after.action, "kick");

    // Put back the version before that edit: its terms return; its switch and section stay as now.
    const restored = await call(`versions/${versions[0].id}/restore`, {});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.rule.threshold, 2);
    assert.equal(restored.body.rule.action, "message");
    assert.equal(restored.body.rule.enabled, false, "restoring what a rule does is not switching it on");
    assert.equal(restored.body.rule.sectionId, sec.id);
    const after = (await call(`rules/${rule.id}/versions`)).body.versions as any[];
    assert.equal(after.length, 2);
    assert.equal(after[0].change, "restore");
    assert.equal(after[0].before.action, "kick", "the restore is listed with what it replaced");
    // …so the restore can be undone the same way.
    const undone = await call(`versions/${after[0].id}/restore`, {});
    assert.equal(undone.status, 200);
    assert.equal(undone.body.rule.action, "kick");

    const trail = ((await jf(`${base}/api/audit?limit=100`, { headers: auth })).body.entries as any[]).filter((e) => e.action === "rule.restore" && e.targetId === rule.id);
    assert.equal(trail.length, 2);
    assert.match(trail[trail.length - 1].summary, /put rule "TK .*" back as it was before owner's change of/);
    assert.equal((await call("versions/00000000-0000-4000-8000-000000000000/restore", {})).status, 404);
  });
});

test("a deleted rule is listed under Recently deleted and comes back under its own id, with its history — once", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const t = tag();
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      jf(`${base}/api/enforcer/${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const rule = (await call("rules", { name: `Gone ${t}`, eventKind: "evt.kill", action: "message", reason: "hi", dryRun: true })).body.rule;
    await call(`rules/${rule.id}`, { reason: "hello" }, "PATCH");
    assert.equal((await jf(`${base}/api/enforcer/rules/${rule.id}`, { method: "DELETE", headers: auth })).status, 200);
    const deleted = (await call("deleted-rules")).body.deleted as any[];
    const mine = deleted.find((v) => v.targetId === rule.id);
    assert.ok(mine, "listed as deleted");
    assert.equal(mine.targetName, `Gone ${t}`);
    assert.equal(mine.before.reason, "hello", "kept whole, as it was when deleted");

    const back = await call(`versions/${mine.id}/restore`, {});
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.rule.id, rule.id, "under its own id");
    assert.equal(back.body.rule.reason, "hello");
    assert.equal(back.body.rule.dryRun, true);
    assert.ok(!((await call("deleted-rules")).body.deleted as any[]).some((v) => v.targetId === rule.id), "no longer listed as deleted");
    const history = (await call(`rules/${rule.id}/versions`)).body.versions as any[];
    assert.deepEqual(history.map((v) => v.change), ["restore", "delete", "edit"], "its history came back with it");
    assert.equal((await call(`versions/${mine.id}/restore`, {})).status, 409, "it is back already");
  });
});

test("a restore is judged by today's checks: a rule whose group has since been deleted does not come back", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const t = tag();
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      jf(`${base}/api/enforcer/${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const group = await repo.playerGroups.create({ name: `Group ${t}`, createdByName: "staff" });
    const rule = (await call("rules", { name: `Welcome ${t}`, eventKind: "app.group.joined", action: "note", reason: "joined", params: { groupId: group.id } })).body.rule;
    assert.ok(rule, "made");
    await jf(`${base}/api/enforcer/rules/${rule.id}`, { method: "DELETE", headers: auth });
    await repo.playerGroups.remove(group.id);
    const mine = ((await call("deleted-rules")).body.deleted as any[]).find((v) => v.targetId === rule.id);
    const refused = await call(`versions/${mine.id}/restore`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /player group no longer exists/);
  });
});

test("a map set's history: an edit and a rename listed; putting back the old name carries every server's pairing back with it", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const t = tag();
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      jf(`${base}/api/mapvote/${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const server = await repo.servers.create({ name: `Vote ${t}`, host: "10.1.1.1", port: 1, password: "x" });
    const set = (await call("sets", { name: `Friday ${t}`, game: "hll", pool: { modeBuckets: [{ mode: "warfare", count: 3 }] } })).body.set;
    await repo.mapVote.setConfig(server.id, { profiles: [{ mapSet: set.name, schedule: null }] });

    const renamed = await call(`sets/${set.id}`, { name: `Fri ${t}`, pool: { modeBuckets: [{ mode: "warfare", count: 4 }] } }, "PUT");
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal((await repo.mapVote.getConfig(server.id))?.profileLinks[0]?.mapSet, `Fri ${t}`, "the rename moved the pairing");
    const versions = (await call(`sets/${set.id}/versions`)).body.versions as any[];
    assert.equal(versions.length, 1);
    assert.equal(versions[0].before.name, `Friday ${t}`);
    assert.equal(versions[0].after.pool.modeBuckets[0].count, 4);
    assert.equal((await call(`sets/${set.id}`, { name: `Fri ${t}` }, "PUT")).status, 200);
    assert.equal(((await call(`sets/${set.id}/versions`)).body.versions as any[]).length, 1, "a save that changed nothing is not listed");

    const restored = await call(`versions/${versions[0].id}/restore`, {});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.set.name, `Friday ${t}`);
    assert.equal(restored.body.set.pool.modeBuckets[0].count, 3);
    assert.equal((await repo.mapVote.getConfig(server.id))?.profileLinks[0]?.mapSet, `Friday ${t}`, "and the old name took the pairing back");
    const after = (await call(`sets/${set.id}/versions`)).body.versions as any[];
    assert.equal(after[0].change, "restore");
  });
});

test("a deleted map set or schedule comes back under its own id and name — unless the name has been taken since", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const t = tag();
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      jf(`${base}/api/mapvote/${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const set = (await call("sets", { name: `Gone ${t}`, game: "hll", pool: { modeBuckets: [] } })).body.set;
    assert.equal((await jf(`${base}/api/mapvote/sets/${set.id}`, { method: "DELETE", headers: auth })).status, 200);
    const gone = ((await call("sets/deleted")).body.deleted as any[]).find((v) => v.targetId === set.id);
    assert.ok(gone);
    // Someone takes the name in the meantime: refused, with what to do.
    const squatter = (await call("sets", { name: `Gone ${t}`, game: "hll", pool: {} })).body.set;
    const refused = await call(`versions/${gone.id}/restore`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /there is a map set called "Gone .*" now — rename it first/);
    await jf(`${base}/api/mapvote/sets/${squatter.id}`, { method: "DELETE", headers: auth });
    const back = await call(`versions/${gone.id}/restore`, {});
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.set.id, set.id);
    assert.equal(back.body.set.name, `Gone ${t}`);
    assert.ok(!((await call("sets/deleted")).body.deleted as any[]).some((v) => v.targetId === set.id));

    const sched = (await call("schedules", { name: `Nights ${t}`, spec: { start: "20:00", end: "23:00" } })).body.schedule;
    assert.equal((await call(`schedules/${sched.id}`, { spec: { start: "21:00", end: "23:00" } }, "PUT")).status, 200);
    const sv = (await call(`schedules/${sched.id}/versions`)).body.versions as any[];
    assert.equal(sv[0].before.spec.start, "20:00");
    assert.equal((await call(`versions/${sv[0].id}/restore`, {})).body.schedule.spec.start, "20:00");
    assert.equal((await jf(`${base}/api/mapvote/schedules/${sched.id}`, { method: "DELETE", headers: auth })).status, 200);
    const schedGone = ((await call("schedules/deleted")).body.deleted as any[]).find((v) => v.targetId === sched.id);
    assert.equal((await call(`versions/${schedGone.id}/restore`, {})).body.schedule.id, sched.id);
    assert.equal((await call("nonsense/deleted")).status, 404);
  });
});
