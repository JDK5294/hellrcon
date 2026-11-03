// "Add a user" with starting access: create the account, then give it its role or preset. The second
// call can be refused where the first was not (a preset carrying what only an owner may hand out),
// and that must not leave a login with no access behind under the name just typed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserWithAccess } from "../lib/createUser.ts";

/** A stand-in for lib/api: records every call, answers from `answer`, throws what it returns as an Error. */
function fakeApi(answer) {
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push(`${opts.method ?? "GET"} ${path}`);
    const out = answer(path, opts);
    if (out instanceof Error) throw out;
    return out;
  };
  return { api, calls };
}

const OWNER_PRESET = { grants: [{ capability: "*", level: "write" }], limits: {} };

test("a refused preset takes the new account back out, and says so", async () => {
  const { api, calls } = fakeApi((path, opts) => {
    if (opts.method === "POST") return { user: { id: "u1" } };
    if (path === "/users/u1/grants") return new Error("only someone who holds every permission on every server (at write) can grant that everywhere");
    return { ok: true };
  });
  await assert.rejects(createUserWithAccess(api, { username: "newbie", password: "pw" }, OWNER_PRESET), /account was not created/);
  assert.deepEqual(calls, ["POST /users", "PUT /users/u1/grants", "DELETE /users/u1"], "no grantless account is left behind");
});

test("a refused role does the same", async () => {
  const { api, calls } = fakeApi((path, opts) => (opts.method === "POST" ? { user: { id: "u2" } } : path.endsWith("/roles") ? new Error("refused") : { ok: true }));
  await assert.rejects(createUserWithAccess(api, { username: "x", password: "pw" }, { roleId: "r1" }), /refused — the account was not created/);
  assert.deepEqual(calls, ["POST /users", "PUT /users/u2/roles", "DELETE /users/u2"]);
});

test("if the undo is refused too, the error names the account left behind", async () => {
  const { api } = fakeApi((path, opts) => (opts.method === "POST" ? { user: { id: "u3" } } : new Error("refused")));
  await assert.rejects(createUserWithAccess(api, { username: "stuck", password: "pw" }, OWNER_PRESET), /"stuck" was created without access/);
});

test("the ordinary paths are unchanged: no starting access is one call, a granted preset is two", async () => {
  const none = fakeApi(() => ({ user: { id: "u4" } }));
  assert.deepEqual(await createUserWithAccess(none.api, { username: "a", password: "pw" }, null), { id: "u4" });
  assert.deepEqual(none.calls, ["POST /users"]);
  const ok = fakeApi(() => ({ user: { id: "u5" } }));
  await createUserWithAccess(ok.api, { username: "b", password: "pw" }, { grants: [{ capability: "server.view", level: "read" }], limits: { "tempban.maxHours": 24 } });
  assert.deepEqual(ok.calls, ["POST /users", "PUT /users/u5/grants"], "nothing is undone when the grant lands");
});
