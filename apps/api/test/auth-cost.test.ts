import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import { principalFromToken } from "../dist/auth.js";
import { hashPassword, sessionClaims, signSession } from "@app/access";

/**
 * Every authenticated request resolves the caller's identity and permissions, so this path's cost
 * is multiplied by all traffic — the panel polls several views on a 15s timer and holds an SSE
 * stream open besides.
 *
 * It used to be strictly serial: fetch the user, then their grants, then their role assignments,
 * then one `roles.get` per distinct role. Four sequential round trips for a user with one role, and
 * one more for each additional role.
 *
 * This counts calls rather than timing anything, so it is stable in CI: a wrapper around the repo
 * records which methods were called and how many times. Timing would tell us about the machine; the
 * call count tells us about the code.
 */
function countingRepo(inner: InMemoryRepository) {
  const calls: string[] = [];
  const wrapNs = <T extends object>(ns: T, name: string): T =>
    new Proxy(ns, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push(`${name}.${String(prop)}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const proxy = new Proxy(inner, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (v && typeof v === "object" && !Array.isArray(v)) return wrapNs(v as object, String(prop));
      return typeof v === "function" ? (v as () => unknown).bind(target) : v;
    },
  }) as unknown as InMemoryRepository;
  return { repo: proxy, calls };
}

test("auth: resolving a principal costs a fixed number of reads, whatever the role count", async () => {
  const base = new InMemoryRepository();
  const user = await base.users.create({ username: "mod", passwordHash: await hashPassword("pw") });

  // Four distinct roles, each held at a different scope, plus a personal grant.
  const roleIds: string[] = [];
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    const role = await base.roles.create({ name, grants: [{ capability: "server.view", level: "read" }], createdByName: "admin" });
    roleIds.push(role.id);
  }
  await base.userRoles.set(user.id, roleIds.map((roleId) => ({ roleId, scopeId: null })));
  await base.grants.create({ userId: user.id, capability: "player.notes", scopeType: "global", scopeId: null, level: "write" });

  const { repo, calls } = countingRepo(base);
  const token = signSession(sessionClaims(user.id, 3600, user.sessionEpoch), "secret");
  const principal = await principalFromToken(token, repo, { sessionSecret: "secret" } as never);

  assert.ok(principal, "the principal resolves");
  assert.equal(principal!.roles.length, 4, "all four roles came back");
  assert.ok(principal!.grants.some((g) => g.capability === "player.notes"), "the personal grant is there");

  // The shape that matters: one read per concern, and roles fetched together rather than one apiece.
  // The fifth read is the open-draft probe (the request builder's view elevation hangs off it);
  // with no draft open it costs nothing further — no app-config read, no ceiling-role read.
  const roleGets = calls.filter((c) => c === "roles.get").length;
  assert.equal(roleGets, 0, `roles must be fetched in one batch, saw ${roleGets} individual gets`);
  assert.equal(calls.filter((c) => c === "roles.getMany").length, 1);
  assert.equal(calls.filter((c) => c === "users.findById").length, 1);
  assert.equal(calls.filter((c) => c === "grants.listByUser").length, 1);
  assert.equal(calls.filter((c) => c === "userRoles.listByUser").length, 1);
  assert.equal(calls.filter((c) => c === "approvals.findDraft").length, 1);
  assert.equal(calls.length, 5, `expected exactly five reads, saw: ${calls.join(", ")}`);
});

test("auth: the read count does not grow with the number of roles held", async () => {
  const counts: number[] = [];
  for (const roleCount of [1, 8]) {
    const base = new InMemoryRepository();
    const user = await base.users.create({ username: `u${roleCount}`, passwordHash: await hashPassword("pw") });
    const ids: string[] = [];
    for (let i = 0; i < roleCount; i++) {
      const role = await base.roles.create({ name: `r${i}`, grants: [], createdByName: "admin" });
      ids.push(role.id);
    }
    await base.userRoles.set(user.id, ids.map((roleId) => ({ roleId, scopeId: null })));

    const { repo, calls } = countingRepo(base);
    const token = signSession(sessionClaims(user.id, 3600, user.sessionEpoch), "secret");
    await principalFromToken(token, repo, { sessionSecret: "secret" } as never);
    counts.push(calls.length);
  }
  assert.deepEqual(counts, [5, 5], "one role and eight roles must cost the same number of reads");
});
