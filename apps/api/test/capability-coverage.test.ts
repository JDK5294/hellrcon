/**
 * The permission model has to line up in both directions, and nothing enforces that at compile time.
 *
 * A capability is a plain string in two unrelated places: the catalog the role editor renders, and
 * the `can(...)` call in a route. Neither knows about the other, so both mismatches are silent:
 *
 *  - a route guarding on a capability the catalog does not list can never be granted to anyone
 *    except an owner (whose `*` matches everything), so the feature works in testing — where the
 *    first account is the owner — and is invisible to every role that should have it.
 *  - a catalog entry no route reads is a switch in the role editor that does nothing. Staff toggle
 *    it, believe they granted access, and are wrong.
 *
 * The design is deliberately per-action and fine-grained, so this list only gets longer; a scan is
 * the only thing that keeps the two ends together as it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_CATALOG } from "@app/access";
import { ADMIN_ACTIONS } from "../dist/routes/kit.js";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

/** Every capability any route actually checks. */
function capabilitiesInUse(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const note = (cap: string, where: string) => used.set(cap, [...(used.get(cap) ?? []), where]);
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    // `can(p.grants, "x", …)`, `canAnywhere(p.grants, "x", …)` and `holdsOutright(p.grants, "x", …)`
    // (global grants the account holds itself) — the inline guards.
    for (const m of src.matchAll(/(?:can(?:Anywhere)?|holdsOutright)\(\s*[\w.]+\s*,\s*"([\w.*-]+)"/g)) note(m[1]!, file);
    // `serverRoute("GET", "/path", "x", …)` — the declared per-server guard.
    for (const m of src.matchAll(/serverRoute\(\s*"[A-Z]+",\s*"[^"]+",\s*"([\w.*-]+)"/g)) note(m[1]!, file);
  }
  // The admin actions choose their capability from the request body, so they are named in a table
  // rather than at a call site — but they are just as much "in use" as the rest.
  for (const [action, def] of Object.entries(ADMIN_ACTIONS)) note(def.cap, `ADMIN_ACTIONS.${action}`);
  return used;
}

test("every capability a route guards on is in the catalog", () => {
  const known = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const strays: string[] = [];
  for (const [cap, where] of capabilitiesInUse()) {
    if (cap === "*") continue; // the owner wildcard, never a catalog entry
    if (!known.has(cap)) strays.push(`${cap} (guarded in ${[...new Set(where)].join(", ")})`);
  }
  assert.deepEqual(strays, [], "these capabilities are unreachable — no role can be granted them:\n" + strays.join("\n"));
});

test("every capability in the catalog is guarded by some route", () => {
  const used = capabilitiesInUse();
  const dead = CAPABILITY_CATALOG.map((c) => c.key).filter((key) => !used.has(key));
  assert.deepEqual(dead, [], "these are switches in the role editor that grant access to nothing:\n" + dead.join("\n"));
});

test("the catalog itself is well formed", () => {
  const seen = new Set<string>();
  for (const c of CAPABILITY_CATALOG) {
    assert.ok(c.key && !seen.has(c.key), `duplicate or empty capability key: ${c.key}`);
    seen.add(c.key);
    // The role editor renders these; a blank one is a checkbox nobody can interpret.
    assert.ok(c.label.trim(), `${c.key} has no label`);
    assert.ok(c.description.trim(), `${c.key} has no description`);
    assert.ok(c.group.trim(), `${c.key} has no group`);
  }
});

/**
 * Scoping is the other half of the model: a capability marked `scoped` can be granted per server,
 * and one that is not is global. Getting that backwards is how a per-server grant silently becomes
 * a global one — which is the failure that actually matters here, so the two ends must agree.
 */
test("server-scoped guards are on capabilities the catalog says are scopable", () => {
  const scoped = new Map(CAPABILITY_CATALOG.map((c) => [c.key, c.scoped]));
  const wrong: string[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    // Anything checked WITH a serverId scope must be scopable. The level is `[^,]+` rather than a
    // literal read|write because a route may pass it through as a variable — an earlier version of
    // this pattern insisted on the literal and so missed every helper that takes the level as an
    // argument, which is exactly where the per-server checks ended up.
    for (const m of src.matchAll(/can\(\s*[\w.]+\s*,\s*"([\w.-]+)"\s*,\s*[^,)]+,\s*\{\s*serverId/g)) {
      const cap = m[1]!;
      if (scoped.get(cap) === false) wrong.push(`${cap} is checked per-server in ${file} but the catalog calls it global`);
    }
    // `serverScope(req, res, ctx, p, "x")` resolves which servers a viewer may read — it asks
    // `can(..., { serverId })` per server, so it is a per-server check like any other, just behind
    // one level of indirection. Without this the scoping is dead code: the catalog would refuse to
    // let anyone hold the per-server grant it exists to serve.
    for (const m of src.matchAll(/serverScope\(\s*[\w.,\s]+?,\s*"([\w.-]+)"\s*\)/g)) {
      const cap = m[1]!;
      if (scoped.get(cap) === false) wrong.push(`${cap} is scope-resolved in ${file} but the catalog calls it global`);
    }
    for (const m of src.matchAll(/serverRoute\(\s*"[A-Z]+",\s*"[^"]+",\s*"([\w.-]+)"/g)) {
      const cap = m[1]!;
      if (scoped.get(cap) === false) wrong.push(`${cap} backs a per-server route in ${file} but the catalog calls it global`);
    }
  }
  assert.deepEqual([...new Set(wrong)], [], wrong.join("\n"));
});
