import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, askedFor } from "./harness.ts";

test("templates: the library starts empty, then filters by kind and edits", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // Nothing out of the box. We used to seed twenty-odd starter presets; a canned list is one
    // more thing to delete before the panel says what a community actually says, and the reason
    // list is long enough on a phone to push the fields below it off the screen. The KINDS are
    // still declared — the picker needs its three tabs whether or not anyone has filled them.
    const all = await jf(`${base}/api/templates`, { headers: auth });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.templates, [], "no starter presets");
    assert.deepEqual(all.body.kinds, ["reason", "message", "broadcast"]);

    await jf(`${base}/api/templates`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "message", body: "Use a mic." }) });
    await jf(`${base}/api/templates`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "reason", body: "Team killing" }) });
    const reasons = await jf(`${base}/api/templates?kind=reason`, { headers: auth });
    assert.ok(reasons.body.templates.every((t: any) => t.kind === "reason"));
    assert.ok(reasons.body.templates.some((t: any) => t.body === "Team killing"));

    // Create.
    const created = await jf(`${base}/api/templates`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "reason", body: "Baiting / harassment" }) });
    assert.equal(created.status, 201);
    const id = created.body.template.id as string;

    // Edit.
    const patched = await jf(`${base}/api/templates/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ body: "Baiting" }) });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.template.body, "Baiting");

    // Delete.
    assert.equal((await jf(`${base}/api/templates/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/templates/${id}`, { method: "DELETE", headers: auth })).status, 404);

    // Validation.
    assert.equal((await jf(`${base}/api/templates`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "bogus", body: "x" }) })).status, 400);
    assert.equal((await jf(`${base}/api/templates`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "reason", body: "  " }) })).status, 400);
    assert.equal((await jf(`${base}/api/templates?kind=bogus`, { headers: auth })).status, 400);
  });
});

test("templates: read needs server.view, write needs server.config (else it is asked for), unauth 401", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    // A brand-new plain user has no grants → can't even read.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/templates`, { headers: plain })).status, 403);
    const asked = await jf(`${base}/api/templates`, { method: "POST", headers: plain, body: JSON.stringify({ kind: "reason", body: "x" }) });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "templates.manage", serverId: null });
    assert.deepEqual((await jf(`${base}/api/templates`, { headers: auth })).body.templates, [], "nothing saved on the asking");
    assert.equal((await jf(`${base}/api/templates`)).status, 401);
  });
});
