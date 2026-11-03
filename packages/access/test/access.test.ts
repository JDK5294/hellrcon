import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { generateToken, hashToken, looksLikeToken } from "../src/tokens.ts";
import { resolveLevel, can, canAnywhere, ownerGrants, mappedRoleAssignments, previewRoleGrants, holdsOutright, type Grant } from "../src/rbac.ts";
import { signSession, verifySession, sessionClaims } from "../src/session.ts";
import { sealSecret, openSecret, isSealed } from "../src/seal.ts";

test("password hash verifies and rejects wrong password", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("password hashes are salted (differ each time)", async () => {
  const a = await hashPassword("same");
  const b = await hashPassword("same");
  assert.notEqual(a, b);
});

test("API token: raw shown once, only hash stored, hash is stable", () => {
  const { token, hash } = generateToken();
  assert.ok(looksLikeToken(token));
  assert.notEqual(token, hash);
  assert.equal(hashToken(token), hash);
});

test("RBAC: global grant applies to any server", () => {
  const grants = ownerGrants();
  assert.equal(resolveLevel(grants, "server.kick", { serverId: "s1" }), "write");
  assert.equal(resolveLevel(grants, "anything", { serverId: "s2" }), "write");
});

test("RBAC: per-server scoping — different level per server", () => {
  const grants: Grant[] = [
    { capability: "server.map", scopeType: "server", scopeId: "s1", level: "write" },
    { capability: "server.map", scopeType: "server", scopeId: "s2", level: "read" },
  ];
  assert.equal(resolveLevel(grants, "server.map", { serverId: "s1" }), "write");
  assert.equal(resolveLevel(grants, "server.map", { serverId: "s2" }), "read");
  assert.equal(resolveLevel(grants, "server.map", { serverId: "s3" }), "none");
});

test("RBAC: group scope + capability wildcard + highest-wins", () => {
  const grants: Grant[] = [
    { capability: "*", scopeType: "group", scopeId: "g1", level: "read" },
    { capability: "server.ban", scopeType: "server", scopeId: "s1", level: "write" },
  ];
  const ctx = { serverId: "s1", serverGroupIds: ["g1"] };
  assert.equal(resolveLevel(grants, "server.ban", ctx), "write"); // server write beats group read
  assert.equal(resolveLevel(grants, "server.view", ctx), "read"); // wildcard group read
  assert.equal(can(grants, "server.view", "read", ctx), true);
  assert.equal(can(grants, "server.view", "write", ctx), false);
});

test("session: sign/verify round-trip and rejects tampering/expiry", () => {
  const secret = "test-secret";
  const token = signSession(sessionClaims("user-1", 3600), secret);
  assert.equal(verifySession(token, secret)?.sub, "user-1");
  assert.equal(verifySession(token, "wrong-secret"), null);
  assert.equal(verifySession(token + "x", secret), null);
  const expired = signSession({ sub: "u", exp: Math.floor(Date.now() / 1000) - 10 }, secret);
  assert.equal(verifySession(expired, secret), null);
  // A sign-in says when it was made; the API's renewals carry that forward as their ceiling.
  assert.ok(Math.abs(verifySession(token, secret)!.auth! - Math.floor(Date.now() / 1000)) <= 1);
});

test("RBAC: explicit none is a veto that beats role/other grants", () => {
  const grants: Grant[] = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" }, // e.g. from a role
    { capability: "server.view", scopeType: "global", scopeId: null, level: "none" }, // personal block
  ];
  assert.equal(resolveLevel(grants, "server.view"), "none");
  assert.equal(can(grants, "server.view", "read"), false);
});

test("RBAC: server-scoped none blocks only that server", () => {
  const grants: Grant[] = [
    { capability: "action.kick", scopeType: "global", scopeId: null, level: "write" },
    { capability: "action.kick", scopeType: "server", scopeId: "s1", level: "none" },
  ];
  assert.equal(can(grants, "action.kick", "write", { serverId: "s1" }), false); // vetoed here
  assert.equal(can(grants, "action.kick", "write", { serverId: "s2" }), true); // untouched elsewhere
  assert.equal(can(grants, "action.kick", "write"), true); // no server ctx: the scoped veto does not apply
});

test("RBAC: wildcard none is a total lockout in its scope", () => {
  const grants: Grant[] = [
    { capability: "*", scopeType: "global", scopeId: null, level: "write" },
    { capability: "*", scopeType: "global", scopeId: null, level: "none" },
  ];
  assert.equal(can(grants, "anything.at.all", "read"), false);
});

test("RBAC: canAnywhere shows nav for any scope but hides on global none", () => {
  const serverOnly: Grant[] = [{ capability: "vip.grant", scopeType: "server", scopeId: "s1", level: "write" }];
  assert.equal(canAnywhere(serverOnly, "vip.grant", "read"), true); // scoped access still shows the area

  const vetoed: Grant[] = [
    { capability: "vip.grant", scopeType: "server", scopeId: "s1", level: "write" },
    { capability: "vip.grant", scopeType: "global", scopeId: null, level: "none" },
  ];
  assert.equal(canAnywhere(vetoed, "vip.grant", "read"), false); // global block hides it

  const scopedVeto: Grant[] = [
    { capability: "vip.grant", scopeType: "global", scopeId: null, level: "read" },
    { capability: "vip.grant", scopeType: "server", scopeId: "s1", level: "none" },
  ];
  assert.equal(canAnywhere(scopedVeto, "vip.grant", "read"), true); // one blocked server does not hide the area
});

// ---- vetoes are per-source: roles union upward, they never subtract from each other ----
//
// Everyone holds every panel role their Discord roles map to, so an admin usually ALSO holds the
// rank-and-file role — and that role's explicit `none` rows must not veto the admin role beside
// it. This is the exact production lockout: the role sync (correctly) gave people all their
// mapped roles, and one restricted role's `none` entries silently cancelled every other role's
// write. "Lower permissions blocking higher permissions."

test("RBAC: a restricted role held BESIDE an admin role never subtracts from it", () => {
  const grants: Grant[] = [
    // the admin role
    { capability: "*", scopeType: "global", scopeId: null, level: "write", source: "role-admin" },
    // the member role: a little access, everything else explicitly none
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read", source: "role-member" },
    { capability: "admin.users", scopeType: "global", scopeId: null, level: "none", source: "role-member" },
    { capability: "*", scopeType: "global", scopeId: null, level: "none", source: "role-member" },
  ];
  assert.equal(resolveLevel(grants, "admin.users"), "write", "the admin role wins over the member role's none");
  assert.equal(can(grants, "admin.users", "write"), true);
  assert.equal(canAnywhere(grants, "admin.users", "read"), true, "nav stays visible too");
});

test("RBAC: a role's own server exception still works, and another role can override it", () => {
  const roleA: Grant[] = [
    { capability: "action.kick", scopeType: "global", scopeId: null, level: "write", source: "role-a" },
    { capability: "action.kick", scopeType: "server", scopeId: "s1", level: "none", source: "role-a" },
  ];
  // Held alone: the role's internal "everywhere except s1" carve-out is intact.
  assert.equal(can(roleA, "action.kick", "write", { serverId: "s1" }), false);
  assert.equal(can(roleA, "action.kick", "write", { serverId: "s2" }), true);

  // A second role granting s1 is a GRANT, and grants union upward across roles.
  const both: Grant[] = [...roleA, { capability: "action.kick", scopeType: "server", scopeId: "s1", level: "write", source: "role-b" }];
  assert.equal(can(both, "action.kick", "write", { serverId: "s1" }), true, "role B's grant is not vetoed by role A");
});

test("RBAC: the PERSONAL none is still the absolute lockout across every role", () => {
  const grants: Grant[] = [
    { capability: "*", scopeType: "global", scopeId: null, level: "write", source: "role-admin" },
    { capability: "admin.users", scopeType: "global", scopeId: null, level: "none" }, // personal — no source
  ];
  assert.equal(resolveLevel(grants, "admin.users"), "none", "a direct none on the person outranks their roles");
  assert.equal(canAnywhere(grants, "admin.users", "read"), false);
  // ...but only for the capability it names.
  assert.equal(can(grants, "server.view", "write"), true);
});

test("seal: round-trips, legacy plaintext passes through, tampering and missing key fail", () => {
  const sealed = sealSecret("rcon-password-123", "key-a");
  assert.ok(isSealed(sealed));
  assert.equal(openSecret(sealed, "key-a"), "rcon-password-123");
  assert.equal(openSecret("plain-old-password", undefined), "plain-old-password"); // legacy rows
  assert.throws(() => openSecret(sealed, undefined)); // sealed + lost key is a loud error
  assert.throws(() => openSecret(sealed, "key-b")); // wrong key
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => openSecret(tampered, "key-a")); // GCM auth catches tampering
});

test("mappedRoleAssignments: dedupes across mappings; nothing mapped means no access", () => {
  // Shared by the API's Discord sign-in and the bot's background re-sync. It lives here, with one
  // set of tests, because two implementations of "what access does this Discord role set grant"
  // drifting apart means the sweep quietly grants or revokes what the login would not.
  const maps = [
    { discordRoleId: "d1", roleId: "r-admin" },
    { discordRoleId: "d1", roleId: "r-mod" },
    { discordRoleId: "d2", roleId: "r-mod" },
    { discordRoleId: "d9", roleId: "r-other" },
  ];
  const ids = (held: string[], m: { discordRoleId: string; roleId: string; scopeId?: string | null }[] = maps) =>
    mappedRoleAssignments(held, m).map((a) => a.roleId).sort();
  assert.deepEqual(ids(["d1", "d2"]), ["r-admin", "r-mod"],
    "one panel role reachable two ways is granted once, and an unheld mapping grants nothing");
  assert.deepEqual(ids(["dX"]), [], "no mapped role is what denies sign-in");
  assert.deepEqual(ids([]), []);
  assert.deepEqual(ids(["d1"], []), [], "no mappings configured grants nobody anything");
  // An unscoped mapping still means everywhere, which is what every existing row is.
  assert.deepEqual(mappedRoleAssignments(["d2"], maps), [{ roleId: "r-mod", scopeId: null }]);
});

test("mappedRoleAssignments: the same role on two servers is two assignments, not one", () => {
  // The whole point of scoping. Deduping on roleId alone would collapse these and silently drop a
  // server's access; deduping on the pair keeps both while still folding a genuine repeat.
  const maps = [
    { discordRoleId: "d-warfare", roleId: "r-mod", scopeId: "srv-a" },
    { discordRoleId: "d-offensive", roleId: "r-mod", scopeId: "srv-b" },
    // Two different Discord roles granting the same panel role on the SAME server: one assignment.
    { discordRoleId: "d-senior", roleId: "r-mod", scopeId: "srv-a" },
  ];
  const got = mappedRoleAssignments(["d-warfare", "d-offensive", "d-senior"], maps);
  assert.equal(got.length, 2, "srv-a granted twice collapses; srv-b is its own assignment");
  assert.deepEqual(got.map((a) => a.scopeId).sort(), ["srv-a", "srv-b"]);

  // Holding only the Warfare role grants it on Warfare and nowhere else — the behaviour that was
  // impossible before, when every mapping was community-wide.
  assert.deepEqual(mappedRoleAssignments(["d-warfare"], maps), [{ roleId: "r-mod", scopeId: "srv-a" }]);

  // A role granted both globally and on one server keeps both rows: the global one is what wins at
  // resolve time, but throwing the other away here would lose it on the next save.
  const both = mappedRoleAssignments(["d1"], [
    { discordRoleId: "d1", roleId: "r-mod", scopeId: null },
    { discordRoleId: "d1", roleId: "r-mod", scopeId: "srv-a" },
  ]);
  assert.equal(both.length, 2);
});

/*
 * What `verifyPassword` does with a stored hash it did not write.
 *
 * The cost parameters are read back out of the string so they can be raised later without
 * invalidating existing hashes — which means the string is input, and nothing checked it. An empty
 * key field derived a zero-length key, compared it against a zero-length expectation, and returned
 * TRUE: every password authenticated. Malformed cost parameters threw a RangeError straight out,
 * turning a sign-in attempt into a 500 rather than a refusal.
 *
 * Not reachable through the API — every write goes through `hashPassword` — but reachable through
 * the paths nobody tests: a restore that truncated a column, a hand-edited row, an importer
 * written later. A function that decides whether somebody gets in fails closed or it is wrong.
 */
test("password: a stored hash we did not write is always a NO, never a yes and never a throw", async () => {
  const notHashes = [
    ["empty key field", "scrypt$16384$8$1$aabb$"],                    // returned TRUE for any password
    ["short key", "scrypt$16384$8$1$aabb$ccdd"],                      // a truncated column
    ["N not a number", "scrypt$abc$8$1$aabb$" + "cd".repeat(64)],     // threw RangeError
    ["N not a power of two", "scrypt$16385$8$1$aabb$" + "cd".repeat(64)], // threw RangeError
    ["N over the ceiling", "scrypt$1048577$8$1$aabb$" + "cd".repeat(64)],
    ["r absurd", "scrypt$16384$99999$1$aabb$" + "cd".repeat(64)],     // threw: over maxmem
    ["p zero", "scrypt$16384$8$0$aabb$" + "cd".repeat(64)],
    ["negative N", "scrypt$-16384$8$1$aabb$" + "cd".repeat(64)],
    ["non-hex salt", "scrypt$16384$8$1$zzzz$" + "cd".repeat(64)],
    ["odd-length hex", "scrypt$16384$8$1$aab$" + "cd".repeat(64)],
    ["empty string", ""],
    ["wrong algorithm", "bcrypt$16384$8$1$aabb$ccdd"],
    ["too few fields", "scrypt$16384$8$1$aabb"],
    ["plaintext", "hunter2"],
  ] as const;

  for (const [name, stored] of notHashes) {
    let result: boolean | string;
    try { result = await verifyPassword("any password at all", stored); }
    catch (e) { result = `THREW ${String(e).slice(0, 60)}`; }
    assert.equal(result, false, `${name}: expected a refusal, got ${String(result)}`);
    // And the same answer for a different guess — a "no" that depends on the guess would mean
    // something about the row is still being consulted.
    assert.equal(await verifyPassword("", stored).catch(() => "THREW"), false, `${name}: empty guess`);
  }
});

test("password: a real hash still verifies, and the cost is still read from the row", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  // The validation must not have narrowed what a legitimate hash may say: rebuild the same hash
  // with the parameters spelled out and confirm it is accepted on its own terms.
  const [, n, r, p, salt, key] = stored.split("$");
  assert.equal(await verifyPassword("correct horse battery staple", `scrypt$${n}$${r}$${p}$${salt}$${key}`), true);
  assert.ok(Number(n) >= 16384 && Number(r) >= 8, "the cost stored is the cost we intend");
});

/**
 * Catalogue integrity. A preset is the one-click way staff assign permissions, and every part of it
 * is a string looked up somewhere else — so a capability renamed in the catalogue leaves a preset
 * granting something that no longer exists. Nothing fails; the role is created, shown in the UI, and
 * quietly confers less than its description says. The API now rejects an unknown capability on the
 * way in, which makes it worse rather than better if a *preset* carries one: applying it 400s.
 */
test("catalogue: capability keys are unique and every one is grouped", async () => {
  const { CAPABILITY_CATALOG } = await import("../src/capabilities.ts");
  const keys = CAPABILITY_CATALOG.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate capability keys: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
  for (const c of CAPABILITY_CATALOG) {
    assert.ok(c.group, `${c.key} has no group — the permission editor renders by group, so it would not appear`);
    assert.ok(c.label, `${c.key} has no label`);
  }
});

test("catalogue: every preset grants capabilities that exist, at valid levels", async () => {
  const { CAPABILITY_CATALOG, ROLE_PRESETS, LIMIT_CATALOG } = await import("../src/capabilities.ts");
  const known = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const knownLimits = new Set(LIMIT_CATALOG.map((l) => l.key));
  const presetKeys = ROLE_PRESETS.map((p) => p.key);
  assert.equal(new Set(presetKeys).size, presetKeys.length, "duplicate preset keys");

  for (const p of ROLE_PRESETS) {
    for (const g of p.grants) {
      assert.ok(g.capability === "*" || known.has(g.capability), `preset "${p.key}" grants unknown capability "${g.capability}"`);
      assert.ok(["none", "read", "write"].includes(g.level), `preset "${p.key}" grants invalid level "${g.level}" on ${g.capability}`);
    }
    const caps = p.grants.map((g) => g.capability);
    assert.equal(new Set(caps).size, caps.length, `preset "${p.key}" lists a capability twice — the later one silently wins`);
    for (const k of Object.keys(p.limits ?? {})) {
      assert.ok(knownLimits.has(k), `preset "${p.key}" sets unknown limit "${k}"`);
    }
  }
});

/*
 * Migration 156 carved three permissions apart, each keeping its name for the part that stayed. The
 * upgrade gives every holder of an old key the same on its new keys, so a factory preset must hold
 * what a migrated role holds — or a fresh install's Administrator and an upgraded one would differ.
 */
test("catalogue: the three carved-off permissions exist, and the presets hold what a migrated role holds", async () => {
  const { CAPABILITY_CATALOG, CAPABILITY_SPLITS, ROLE_PRESETS } = await import("../src/capabilities.ts");
  const known = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const carved: Record<string, string[]> = {
    "admin.moderation": ["moderation.chatfilter", "moderation.zones"],
    "seeding.config": ["seeding.rewards"],
    "admin.users": ["discord.setup", "admin.online"],
  };
  for (const [old, parts] of Object.entries(carved)) {
    assert.deepEqual(CAPABILITY_SPLITS[old], [old, ...parts], `${old} kept its name and gained its siblings`);
    for (const k of [old, ...parts]) assert.ok(known.has(k), `${k} is in the catalogue`);
  }
  assert.equal(CAPABILITY_CATALOG.find((c) => c.key === "seeding.rewards")?.scoped, true, "the reward is per server, like seeding");

  const administrator = new Set(ROLE_PRESETS.find((p) => p.key === "admin")!.grants.map((g) => g.capability));
  for (const k of ["admin.users", "discord.setup", "admin.online"]) assert.ok(!administrator.has(k), `the Administrator never held ${k}`);
  for (const k of ["moderation.chatfilter", "moderation.zones", "seeding.rewards"]) assert.ok(administrator.has(k), `the Administrator holds ${k}`);
  const moderator = ROLE_PRESETS.find((p) => p.key === "moderator")!.grants;
  for (const [old, parts] of Object.entries(carved)) {
    const level = moderator.find((g) => g.capability === old)?.level;
    for (const k of parts) assert.equal(moderator.find((g) => g.capability === k)?.level, level, `the moderator holds ${k} as it holds ${old}`);
  }
});

test("catalogue: the owner preset really is total access, and viewer really is read-only", async () => {
  const { ROLE_PRESETS } = await import("../src/capabilities.ts");
  const owner = ROLE_PRESETS.find((p) => p.key === "owner");
  assert.ok(owner, "the owner preset exists");
  // Whatever else it lists, an owner has to end up with everything — the lockout guards in the API
  // key off exactly this shape (a global "*" write).
  assert.ok(owner!.grants.some((g) => g.capability === "*" && g.level === "write"), "owner must hold the wildcard at write");

  const viewer = ROLE_PRESETS.find((p) => p.key === "viewer");
  assert.ok(viewer, "the viewer preset exists");
  assert.ok(viewer!.grants.every((g) => g.level !== "write"), "viewer must not grant write anywhere");
});

/*
 * Who may sign a request: someone who could PERFORM it — the capability at write, on that server.
 * That is the whole rule. There is deliberately NO separate approver list, no "ask" grant level,
 * and no never-yourself clause: a request CLIMBS (each signature covers what that signer's
 * authority reaches and the remainder files onwards), so a signature can never reach past what
 * its signer could do unilaterally — which is exactly what a never-yourself clause was supposed
 * to protect, at the cost of stranding a promoted requester's own ask entirely.
 */
test("approvalRefusal: you sign only what you could do yourself — including your own request", async () => {
  const { approvalRefusal } = await import("../src/rbac.ts");
  const write = (cap: string, serverId: string | null = null): Grant =>
    serverId ? { capability: cap, scopeType: "server", scopeId: serverId, level: "write" } : { capability: cap, scopeType: "global", scopeId: null, level: "write" };

  const mod = { userId: "u-mod", grants: [write("action.permaban")] };
  assert.equal(approvalRefusal(mod, "action.permaban", "s1"), null, "a write-holder signs an asker's request");

  // The write must cover THAT server: holding permaban on s1 signs nothing on s2.
  const scoped = { userId: "u-scoped", grants: [write("action.permaban", "s1")] };
  assert.equal(approvalRefusal(scoped, "action.permaban", "s1"), null);
  assert.match(approvalRefusal(scoped, "action.permaban", "s2")!, /you could do yourself/);

  // Anyone without the write is exactly who CANNOT sign — proposing is not performing, so a
  // grant-less peer can never approve a peer's request. The hierarchy is the matrix itself.
  const peer = { userId: "u-peer", grants: [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" } as Grant] };
  assert.match(approvalRefusal(peer, "action.permaban", "s1")!, /you could do yourself/);

  // The owner wildcard is a write on everything, so it signs everything.
  const owner = { userId: "u-owner", grants: ownerGrants() };
  assert.equal(approvalRefusal(owner, "action.permaban", "s2"), null);
});

/*
 * The builder's view elevation: read-clamped grants under a ceiling. The whole safety story is
 * that nothing here can ever satisfy a write check, and that vetoes stay in their lanes — the
 * ceiling's own `none` rows silence only the elevation, while a personal lockout silences
 * everything, elevation included.
 */
test("requestViewGrants: read-clamped, ceiling nones bind only themselves, lockout still absolute", async () => {
  const { requestViewGrants, approvalRefusal } = await import("../src/rbac.ts");

  // No ceiling: one global wildcard READ — see everything, do nothing.
  const everything = requestViewGrants(null);
  assert.equal(can(everything, "audit.trail", "read"), true);
  assert.equal(can(everything, "action.permaban", "write", { serverId: "s1" }), false, "elevation never writes");

  // A ceiling role: its writes become reads, its explicit nones come along.
  const capped = requestViewGrants([
    { capability: "server.view", level: "read" },
    { capability: "action.permaban", level: "write" },
    { capability: "economy.balances", level: "none" },
  ]);
  assert.equal(can(capped, "server.view", "read"), true);
  assert.equal(can(capped, "action.permaban", "read"), true, "the ceiling's write clamps to read");
  assert.equal(can(capped, "action.permaban", "write", { serverId: "s1" }), false);
  assert.equal(can(capped, "economy.balances", "read"), false, "what the ceiling blocks stays invisible");
  assert.equal(can(capped, "audit.trail", "read"), false, "nothing outside the ceiling");

  // The ceiling's none silences only the elevation: the user's OWN grant on that capability wins.
  const own: Grant[] = [{ capability: "economy.balances", scopeType: "global", scopeId: null, level: "write" }];
  assert.equal(can([...own, ...capped], "economy.balances", "write"), true, "per-source vetoes — the ceiling never subtracts from real grants");

  // The personal lockout is source-less and absolute — elevation does not resurrect a blocked account.
  const locked: Grant[] = [{ capability: "*", scopeType: "global", scopeId: null, level: "none" }];
  assert.equal(can([...locked, ...everything], "server.view", "read"), false);

  // And an elevated bystander still cannot sign anything: approval demands the REAL write.
  const peeker = { userId: "u-peek", grants: everything };
  assert.match(approvalRefusal(peeker, "action.permaban", "s1")!, /you could do yourself/);
});

/*
 * "View as" a role: the server reads with the previewer's grants held down to the role's. It must
 * never show more than the previewer may see anywhere, never more than the role confers, and —
 * for every capability anyone named — exactly the lower of the two, server by server.
 */
test("previewRoleGrants: never above the previewer or the role, and the lower of the two everywhere", () => {
  const KNOWN = ["server.view", "audit.trail", "admin.users", "vip.revoke", "staff.profiles"];
  const LEVELS = ["none", "read", "write"] as const;
  const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);
  const g = (capability: string, level: "none" | "read" | "write", scopeId: string | null = null, source?: string): Grant =>
    ({ capability, level, scopeType: scopeId ? "server" : "global", scopeId, ...(source ? { source } : {}) });
  const previewers: Record<string, Grant[]> = {
    owner: ownerGrants(),
    "one server's owner": [g("*", "write", "A")],
    "server view on A, users anywhere": [g("server.view", "read", "A"), g("admin.users", "read")],
    "owner locked out of VIP": [g("*", "write"), g("vip.revoke", "none")],
    "admin role that vetoes the audit trail": [g("*", "write", null, "R1"), g("audit.trail", "none", null, "R1")],
  };
  const roles: Record<string, { capability: string; level: "none" | "read" | "write" }[]> = {
    nothing: [],
    "server view": [{ capability: "server.view", level: "read" }],
    owner: [{ capability: "*", level: "write" }],
    "read all but users": [{ capability: "*", level: "read" }, { capability: "admin.users", level: "none" }],
  };
  const scopes = [{}, { serverId: "A" }, { serverId: "B" }];
  for (const [who, real] of Object.entries(previewers)) {
    for (const [name, role] of Object.entries(roles)) {
      const preview = previewRoleGrants(real, role, KNOWN);
      const bundle = role.map((r) => ({ ...r, scopeType: "global" as const, scopeId: null, source: "role" }));
      for (const c of [...KNOWN, "plugin.page"]) {
        for (const ctx of scopes) {
          const got = resolveLevel(preview, c, ctx), mine = resolveLevel(real, c, ctx), theirs = resolveLevel(bundle, c);
          const at = `${who} viewing ${name}: ${c} at ${JSON.stringify(ctx)}`;
          assert.ok(rank(got) <= rank(mine), `${at} — never above the previewer (${got} > ${mine})`);
          assert.ok(rank(got) <= rank(theirs), `${at} — never above the role (${got} > ${theirs})`);
          // A capability nobody named, under a wildcard held on one server only, may read as less.
          if (c !== "plugin.page" || !real.some((x) => x.capability === "*" && x.scopeType === "server")) {
            assert.equal(got, rank(mine) < rank(theirs) ? mine : theirs, `${at} — the lower of the two`);
          }
        }
        for (const level of ["read", "write"] as const) {
          if (canAnywhere(preview, c, level)) assert.ok(canAnywhere(real, c, level), `${who} viewing ${name}: ${c} ${level} shown anywhere only if held`);
        }
      }
      const owns = holdsOutright(preview, "*", "write");
      assert.equal(owns, holdsOutright(real, "*", "write") && name === "owner", `${who} viewing ${name}: owner only when both are`);
    }
  }
});

test("previewRoleGrants: a role with nothing shows nothing, even to the owner", () => {
  const preview = previewRoleGrants(ownerGrants(), [], ["server.view", "audit.trail"]);
  assert.deepEqual(preview, []);
  assert.equal(canAnywhere(preview, "server.view", "read"), false);
  assert.equal(holdsOutright(preview, "*", "read"), false);
});
