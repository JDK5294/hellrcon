// View-as-role preview narrowing — the pure grant math behind "see what this role sees".
//
// The one invariant that matters for safety: the preview can only ever show LESS than the
// previewer's own access. Never a capability they lack, never a higher level than they hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewGrantsForRole, hasCap, isOwner, canOnServer } from "../lib/access.ts";
import { OUTRIGHT_CAPS, canOpenRoute, pluginRouteById, setPluginPages } from "../lib/routes.ts";

const g = (capability, level, extra = {}) => ({ capability, level, scopeType: "global", scopeId: null, ...extra });

test("preview intersects: a capability the previewer lacks is never shown", () => {
  const real = [g("moderation.bans", "write"), g("server.view", "read")];
  const role = [{ capability: "moderation.bans", level: "write" }, { capability: "economy.balances", level: "write" }];
  const out = previewGrantsForRole(real, role);
  assert.ok(hasCap(out, "moderation.bans", "write"), "shared cap survives");
  assert.ok(!hasCap(out, "economy.balances", "read"), "a cap the previewer lacks is dropped, even though the role grants it");
});

test("preview clamps the level down to the previewer's own", () => {
  const real = [g("moderation.bans", "read")]; // previewer can only READ bans
  const role = [{ capability: "moderation.bans", level: "write" }]; // role could write
  const out = previewGrantsForRole(real, role);
  assert.ok(hasCap(out, "moderation.bans", "read"));
  assert.ok(!hasCap(out, "moderation.bans", "write"), "preview never exceeds the previewer's own level");
});

test("a role block is honoured; an owner previewing owner keeps the wildcard", () => {
  const blocked = previewGrantsForRole([g("server.view", "write")], [{ capability: "server.view", level: "none" }]);
  assert.ok(!hasCap(blocked, "server.view", "read"), "a role `none` hides the area in preview");

  const ownerView = previewGrantsForRole([g("*", "write")], [{ capability: "*", level: "write" }]);
  assert.ok(hasCap(ownerView, "anything.at.all", "write"), "owner previewing owner sees everything");

  // A non-owner previewing a wildcard role expands to THEIR caps only — never god mode.
  const limited = previewGrantsForRole([g("server.view", "read")], [{ capability: "*", level: "write" }]);
  assert.ok(hasCap(limited, "server.view", "read"));
  assert.ok(!hasCap(limited, "moderation.bans", "read"), "the wildcard does not conjure caps the previewer lacks");
});

/*
 * A preview must never mint ownership. Owner-only screens (a plugin's page can be one) open on a
 * GLOBAL "*" at write and nothing else, so a "*" confined to one server — full control of that
 * server, which is what lets this account open Users & roles and press Preview at all — must stay
 * confined in the preview too. It used to be widened to global the moment its holder previewed
 * the Owner role, and the sidebar and palette then offered them the owner's tab.
 */
/** An owner-only screen: no capability, only the owner gate. */
const OWNER_ONLY = { ownerOnly: true };

test("previewing the Owner role keeps a per-server \"*\" at its server — never an owner", () => {
  const scoped = [g("*", "write", { scopeType: "server", scopeId: "s1" })];
  const pv = previewGrantsForRole(scoped, [{ capability: "*", level: "write" }]);
  assert.equal(isOwner(pv), false, "a server's owner previewing the Owner role is not an owner");
  assert.equal(canOpenRoute(pv, OWNER_ONLY), false, "nor offered an owner-only screen");
  assert.ok(!pv.some((x) => x.capability === "*" && (x.scopeType ?? "global") === "global" && x.level === "write"), "no global \"*\" at write in the preview");
  // …while the preview still shows what they really hold, where they hold it.
  assert.ok(hasCap(pv, "admin.users", "write"), "their own reach on s1 still opens Users & roles");
  assert.ok(canOnServer(pv, "anything", "s1"), "full control of s1 survives");
  assert.ok(!canOnServer(pv, "anything", "s2", "read"), "and stays on s1");

  // A real owner previewing the Owner role is still the owner they are.
  const owner = previewGrantsForRole([g("*", "write", { source: "role-owner" })], [{ capability: "*", level: "write" }]);
  assert.equal(isOwner(owner), true);
  assert.equal(canOpenRoute(owner, OWNER_ONLY), true);
  // …and previewing a read-only wildcard role, they are not.
  assert.equal(isOwner(previewGrantsForRole([g("*", "write")], [{ capability: "*", level: "read" }])), false);
});

test("a non-owner's wildcard is clamped and vetoed as they hold it, beside their other capabilities", () => {
  // The role's level still caps the server's "*".
  const readOnly = previewGrantsForRole([g("*", "write", { scopeType: "server", scopeId: "s1" })], [{ capability: "*", level: "read" }]);
  assert.ok(canOnServer(readOnly, "anything", "s1", "read") && !canOnServer(readOnly, "anything", "s1", "write"));

  // Capabilities held outright beside a server's "*" are not lost when the wildcard stays put.
  const mixed = previewGrantsForRole(
    [g("*", "write", { scopeType: "server", scopeId: "s1" }), g("moderation.bans", "write")],
    [{ capability: "*", level: "write" }],
  );
  assert.ok(canOnServer(mixed, "moderation.bans", "s2"), "a global capability stays global");
  assert.ok(!canOnServer(mixed, "server.view", "s2", "read"), "the wildcard does not");
  assert.equal(isOwner(mixed), false);

  // Their own veto on that server binds the preview as it binds them.
  const vetoed = previewGrantsForRole(
    [g("*", "write", { scopeType: "server", scopeId: "s1", source: "role-a" }), g("*", "none", { scopeType: "server", scopeId: "s1", source: "role-a" })],
    [{ capability: "*", level: "write" }],
  );
  assert.ok(!canOnServer(vetoed, "anything", "s1", "read"));

  // A global "*" short of ownership (read) stays a global read — never promoted to write.
  const globalRead = previewGrantsForRole([g("*", "read")], [{ capability: "*", level: "write" }]);
  assert.ok(hasCap(globalRead, "anything", "read") && !hasCap(globalRead, "anything", "write"));
  assert.equal(isOwner(globalRead), false);

  // The request builder's view elevation is not carried over as a role-preview "*".
  const building = previewGrantsForRole(
    [g("*", "read", { source: "request-view" }), g("server.view", "read")],
    [{ capability: "*", level: "write" }],
  );
  assert.ok(!building.some((x) => x.capability === "*"), "no wildcard from the elevation");
  assert.ok(hasCap(building, "server.view", "read"));
});

/** A destination granted by name only: a plugin's page with an outright permission, as the API lists
 *  one. Each test that uses it takes it away again. */
const outrightPage = () => {
  setPluginPages([{ plugin: "vault", id: "vault", title: "Vault", section: "Monitor", blurb: "A page a plugin adds.", permission: "vault.view", outright: true, ownerOnly: false }]);
  return pluginRouteById("vault");
};

/*
 * A preview mints GLOBAL grants of its own source — exactly what an outright check accepts. So for
 * an outright-only capability the previewer's ceiling is asked the outright question too: a "*"
 * confined to one server (or a role held on one server) must not open, in preview, a destination
 * their own view keeps shut.
 */
test("preview never opens an outright destination the previewer's own view keeps shut", (t) => {
  t.after(() => setPluginPages([]));
  const row = outrightPage();
  const cap = row.caps[0];
  assert.ok(OUTRIGHT_CAPS.has(cap), "the outright caps are collected from the registry");
  const role = [{ capability: cap, level: "read" }];
  const oneServer = [g("*", "write", { scopeType: "server", scopeId: "s1" })];
  assert.equal(canOpenRoute(oneServer, row), false, "their own view keeps it shut");
  assert.equal(canOpenRoute(previewGrantsForRole(oneServer, role, OUTRIGHT_CAPS), row), false, "and so does the preview");
  const viaServerRole = [g(cap, "read", { scopeType: "server", scopeId: "s1", source: "role-x" })];
  assert.equal(canOpenRoute(previewGrantsForRole(viaServerRole, role, OUTRIGHT_CAPS), row), false, "nor a role held on one server");
  const holder = [g(cap, "read")];
  assert.equal(canOpenRoute(previewGrantsForRole(holder, role, OUTRIGHT_CAPS), row), true, "a real holder previews it as before");
});

/*
 * The wildcard a preview mints is a global "*" of its own source, and it opens every outright
 * capability with it. Whether it may be minted is asked of "*" alone, which cannot see the
 * previewer's own veto on ONE outright capability — so a global-read auditor kept out of a screen
 * granted by name, or an owner who locked themselves out of it, previewed the Owner role and was
 * offered the screen their own view keeps shut.
 */
test("preview carries the previewer's own veto on an outright capability past a minted wildcard", (t) => {
  t.after(() => setPluginPages([]));
  const row = outrightPage();
  const cap = row.caps[0];
  const ownerRole = [{ capability: "*", level: "write" }];
  const auditorRole = [g("*", "read", { source: "role-aud" }), g(cap, "none", { source: "role-aud" })];
  assert.equal(canOpenRoute(auditorRole, row), false, "their own view keeps it shut");
  assert.equal(canOpenRoute(previewGrantsForRole(auditorRole, ownerRole, OUTRIGHT_CAPS), row), false, "and so does previewing the Owner role");
  const personal = [g("*", "read"), g(cap, "none")];
  assert.equal(canOpenRoute(previewGrantsForRole(personal, [{ capability: "*", level: "read" }], OUTRIGHT_CAPS), row), false, "the same rows held personally");
  const lockedOwner = [g("*", "write"), g(cap, "none", { source: "role-x" }), g("*", "write", { source: "role-x" })];
  assert.equal(canOpenRoute(lockedOwner, row), true, "a role's veto binds only that role — this owner still holds it");
  const selfVetoed = [g("*", "write"), g(cap, "none")];
  assert.equal(canOpenRoute(selfVetoed, row), false, "an owner's personal veto keeps it shut");
  assert.equal(canOpenRoute(previewGrantsForRole(selfVetoed, ownerRole, OUTRIGHT_CAPS), row), false, "and the preview honours it");
  // The veto is narrowing only: everything else the minted wildcard opens stays open.
  const pv = previewGrantsForRole(auditorRole, ownerRole, OUTRIGHT_CAPS);
  assert.ok(hasCap(pv, "moderation.bans", "read"), "the rest of their global read survives");
  // And a real holder is not touched.
  assert.equal(canOpenRoute(previewGrantsForRole([g("*", "write")], ownerRole, OUTRIGHT_CAPS), row), true);
});
