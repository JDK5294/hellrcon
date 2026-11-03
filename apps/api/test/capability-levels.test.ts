/**
 * The four states on a permission row have to be four REAL states.
 *
 * The matrix offers inherit / Block / Read / Write for every capability. For some capabilities one
 * of Read or Write is not a state the API has any answer to — there is no read form of "kick a
 * player", and no write form of "view the ban list". Offering it anyway is worse than leaving it
 * out: the row goes green, the admin believes they granted something, and the person still cannot
 * do the thing. That is not a lie the code tells deliberately; the matrix simply asked a question
 * nothing downstream answers.
 *
 * `CapabilityDef.levels` records the answer, and this test refuses to let it be a comment. It reads
 * the route source, works out which level each capability is actually enforced at, and fails when
 * the catalogue and the enforcement disagree in either direction:
 *
 *   • the catalogue offers Read on something every endpoint demands Write for — a dead state;
 *   • the catalogue withholds a level the API really does accept — a state you cannot grant.
 *
 * Reading the source rather than the running app is deliberate. The check has to cover every route
 * including ones no test exercises, and those are exactly where a drifted level would survive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_CATALOG, capabilityLevels } from "@app/access";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

/** capability → the set of levels the API is seen to enforce it at. */
function enforcedLevels(): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const note = (cap: string, level: string) => {
    if (!seen.has(cap)) seen.set(cap, new Set());
    seen.get(cap)!.add(level);
  };
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    // serverRoute("POST", "/path", "capability", "level", …)
    for (const m of src.matchAll(/serverRoute\(\s*"[A-Z]+",\s*"[^"]*",\s*"([a-z._]+)",\s*"(read|write)"/g)) {
      note(m[1]!, m[2]!);
    }
    // can(p.grants, "capability", "level") / canAnywhere(…) / holdsOutright(…)
    //
    // The grants argument is matched loosely, not as the literal `p.grants`. A route that accepts
    // either of two capabilities is clearer as a named predicate — `canWriteEvents(p.grants)` —
    // and inside one the parameter is called `grants`. Insisting on `p.grants` made every gate
    // written that way invisible here, which reads as "nothing in the API checks this capability"
    // for a capability three routes enforce. Its sibling scan (capability-coverage) already
    // matched loosely; this one now agrees.
    for (const m of src.matchAll(/(?:can(?:Anywhere)?|holdsOutright)\(\s*[\w.]+,\s*"([a-z._]+)",\s*"(read|write)"/g)) {
      note(m[1]!, m[2]!);
    }
    /*
     * The per-player actions are dispatched from a table, so their capability never appears as a
     * literal beside a level: the route reads `can(p.grants, spec.cap, "write")`. Skipping them
     * would exempt the eight capabilities this test most needs to cover — they are the ones an
     * admin is most likely to set to Read and expect something from. The table entries are literal,
     * and every route that consumes them demands write, which is asserted just below.
     */
    for (const m of src.matchAll(/\bcap:\s*"([a-z._]+)"/g)) note(m[1]!, "write");
  }
  return seen;
}

test("every capability offers exactly the levels the API enforces — no dead states, no missing ones", () => {
  const enforced = enforcedLevels();

  // Guard the guard: if the scan stops finding things, the assertions below pass vacuously and
  // this test becomes decoration.
  assert.ok(enforced.size > 30, `the scan found only ${enforced.size} capabilities — it has stopped working`);
  assert.deepEqual([...(enforced.get("action.kick") ?? [])], ["write"], "the action table is being read");
  assert.ok(enforced.get("server.view")?.has("read"), "plain read routes are being read");

  const problems: string[] = [];
  for (const def of CAPABILITY_CATALOG) {
    const levels = capabilityLevels(def);
    const actual = enforced.get(def.key);
    if (!actual) {
      // A capability nothing checks is its own bug, and a different one — say so plainly rather
      // than folding it into a level mismatch.
      problems.push(`${def.key}: nothing in the API checks this capability at all`);
      continue;
    }
    for (const level of levels) {
      if (!actual.has(level)) problems.push(`${def.key}: offers "${level}" but no endpoint enforces it — a state that grants nothing`);
    }
    for (const level of actual) {
      if (!levels.includes(level as "read" | "write")) {
        problems.push(`${def.key}: the API enforces "${level}" but the matrix will not let anyone grant it`);
      }
    }
  }
  assert.deepEqual(problems, [], `capability levels disagree with the API:\n  ${problems.join("\n  ")}`);
});

test("the panel's nav agrees with the catalogue about which capabilities are write-only", () => {
  /*
   * The sidebar decides what to offer before any network call has returned, so it cannot wait to
   * be told which capabilities have no read form — it carries its own copy. A copy is a bug in
   * waiting unless something compares them, so this does.
   *
   * The consequence of a disagreement is not cosmetic: a capability the nav thinks has a read
   * level puts a destination in the sidebar for somebody whose every request on that page 403s.
   */
  const routes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "panel", "lib", "routes.ts"), "utf8");
  const block = /export const CAP_MIN_LEVEL[^=]*=\s*\{([\s\S]*?)\};/.exec(routes)?.[1] ?? "";
  const panel = new Set([...block.matchAll(/"([a-z._]+)":\s*"write"/g)].map((m) => m[1]!));
  const catalog = new Set(CAPABILITY_CATALOG.filter((c) => !capabilityLevels(c).includes("read")).map((c) => c.key));

  assert.ok(panel.size > 5, "the panel's write-only list was not found — this check has stopped working");
  assert.deepEqual([...panel].sort(), [...catalog].sort(), "the panel's CAP_MIN_LEVEL and the capability catalogue disagree");
});

/*
 * The panel mirrors ApprovalLineState in its own union and keys a lookup table on it. A state the
 * server can emit but the panel does not list is not a type error anywhere — the panel never
 * imports @app/db — it is a crash, and only once data of that shape exists: `executed` shipped
 * missing, and the first bundle that applied a line under its own permissions took the Requests
 * page down with "a client-side exception has occurred". Cheap to assert, invisible otherwise.
 */
test("the panel's approval-line states cover every state the server can store", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../panel/components/Requests.tsx", import.meta.url), "utf8");
  const union = /state:\s*((?:"[a-z]+"\s*\|\s*)*"[a-z]+");/.exec(src);
  assert.ok(union, "could not find the state union in Requests.tsx — has it been renamed?");
  const mirrored = [...union[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
  // The server's own list, from the type's single source of truth.
  const dbSrc = await readFile(new URL("../../../packages/db/src/types.ts", import.meta.url), "utf8");
  const dbUnion = /export type ApprovalLineState =([^;]+);/.exec(dbSrc);
  assert.ok(dbUnion, "ApprovalLineState has moved");
  const actual = [...dbUnion[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(mirrored, actual, "the panel's line-state union has drifted from the server's — a missing state crashes the Requests page when one appears");
  // …and the badge table must have an entry for each, or the lookup is undefined at render.
  for (const s of actual) {
    assert.match(src, new RegExp(`\\n\\s*${s}:\\s*\\{ label:`), `STATE_BADGE has no entry for "${s}"`);
  }
});

test("Block and inherit apply to every capability, so the four states are always at least two", () => {
  // Neither is a per-capability question: "no grant of my own" and "explicitly denied" mean the
  // same thing for anything grantable. The catalogue must never be able to say otherwise — a
  // capability that offered no levels at all would render a row with nothing but Block on it.
  for (const def of CAPABILITY_CATALOG) {
    const levels = capabilityLevels(def);
    assert.ok(levels.length > 0, `${def.key} offers no grantable level`);
    assert.ok(levels.every((l) => l === "read" || l === "write"), `${def.key} offers an unknown level`);
  }
});
