// What an approver is shown about a filed CALL. Pressing Approve on "Broadcast to the server"
// without sight of the message is signing blind, so these words are load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeDetails } from "../lib/requestLines.ts";

test("a comment typed for a call is read first, ahead of the four fields a line has room for", () => {
  // A selection's VIP grant: the comment every VIP added carries is the fifth field of its body.
  assert.equal(
    routeDetails({ body: { players: [{ playerId: "1" }], mode: "duration", days: 1, hours: 0, cumulative: true, comment: "seeded the server" } }),
    "comment: “seeded the server” · mode: “duration” · days: 1 · hours: 0 · +1 more · changes players",
  );
});

test("a filed call shows what it would do", () => {
  assert.equal(
    routeDetails({ body: { message: "Server restarting in 10", dryRun: false } }),
    "message: “Server restarting in 10” · dryRun: false",
  );
  // The one an approver most needs to read in full before pressing Approve.
  assert.match(routeDetails({ body: { command: "AdminKickAll" } }), /command: “AdminKickAll”/);
});

test("a long message is trimmed, not dropped, and structured parts are named", () => {
  const long = "x".repeat(200);
  const out = routeDetails({ body: { message: long } });
  assert.ok(out.length < 120, out.length.toString());
  assert.match(out, /…/);
  // A whole profile cannot fit on a line; which parts it touches can.
  assert.equal(routeDetails({ body: { profiles: [1, 2], modules: { a: 1 } } }), "changes profiles, modules");
  assert.equal(routeDetails({ body: { enabled: true, profiles: [1] } }), "enabled: true · changes profiles");
});

test("nothing to say says nothing", () => {
  assert.equal(routeDetails({ body: {} }), "");
  assert.equal(routeDetails({}), "");
  assert.equal(routeDetails({ body: null }), "");
  // Values that carry no information of their own are skipped rather than printed as "null".
  assert.equal(routeDetails({ body: { a: null, b: undefined, c: 1 } }), "c: 1");
});

test("a call whose subject is in the path names it FIRST", () => {
  // "Rename a map · name: Foy Warfare" is unsignable: an approver cannot tell which map. The
  // server's own id is left out — the line already carries the server.
  assert.equal(
    routeDetails({ params: { id: "s1", mapId: "stmereeglise_warfare" }, body: { name: "Ste-Mère-Église (Warfare)" } }),
    "mapId: stmereeglise_warfare · name: “Ste-Mère-Église (Warfare)”",
  );
  assert.equal(
    routeDetails({ params: { id: "s1", moduleId: "no_leader" }, body: { enabled: true, dryRun: false } }),
    "moduleId: no_leader · enabled: true · dryRun: false",
  );
  // Nothing but the server: nothing extra to say.
  assert.equal(routeDetails({ params: { id: "s1" }, body: { enabled: true } }), "enabled: true");
  assert.equal(routeDetails({ params: null, body: { enabled: true } }), "enabled: true");
  // A subject with no body of its own is still worth printing.
  assert.equal(routeDetails({ params: { id: "s1", mapId: "foy_warfare" }, body: {} }), "mapId: foy_warfare");
});

test("a call filed with its subject named says it in those words, ahead of the body", () => {
  // Off the per-server screens the path's `id` IS the subject — the account, the group — and the
  // API names it when the call is filed. "Set a staff account's roles · changes roleIds" was
  // unsignable: whose roles?
  assert.equal(
    routeDetails({ params: { id: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }, subject: ["account: KREITZ", "roles: Head Admin"], body: { roleIds: ["9a2e"] } }),
    "account: KREITZ · roles: Head Admin · changes roleIds",
  );
  assert.equal(routeDetails({ params: { id: "g1" }, subject: ["account: KREITZ"], body: {} }), "account: KREITZ");
});
