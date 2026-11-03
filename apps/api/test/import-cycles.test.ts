import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The approvals spine imports one way, and stays that way.
 *
 * A route wrapper that files a refused call has to reach the filing code, so the filing code must
 * not reach back to the routing layer. It did, briefly: `routes/kit → ask → approvals → kit`,
 * because filing lived next to EXECUTING and executing needs the game helpers in `kit`. Node
 * tolerates that until the day one of those modules touches an imported binding while it is still
 * evaluating, and then the whole API fails to start with a message about an uninitialised
 * variable. Splitting the leaves (`requests.ts`, `approval-cards.ts`) is what fixed it, and this is
 * what keeps it fixed.
 *
 * Scoped to the approvals modules on purpose: the API has a long-standing knot of its own around
 * `routes/kit ↔ context ↔ plugin-host → discord-* → shop`, which is not this test's business to
 * fail over. Type-only imports are erased before Node ever sees them, so they cannot form a cycle
 * and are not counted.
 */
const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), "../src"));
/** The modules the request path is built from — none of them may sit in a cycle. */
const SPINE = ["ask.ts", "requests.ts", "approval-cards.ts", "approvals.ts", "replay.ts"];

const IMPORT = /^import\s+(?!type\b)([\s\S]*?)from "(\.[^"]+)";$/gm;
function valueImports(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const clause = m[1] ?? "";
    // `import { type A, type B } from …` is erased too.
    const braced = clause.trim().startsWith("{") ? clause.replace(/[{}]/g, "") : null;
    if (braced !== null && braced.split(",").every((s) => !s.trim() || s.trim().startsWith("type "))) continue;
    const target = normalize(join(dirname(file), m[2]!)).replace(/\.js$/, ".ts");
    if (existsSync(target)) out.push(target);
  }
  return out;
}

function graph(dir: string, into: Record<string, string[]> = {}): Record<string, string[]> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) graph(p, into);
    else if (e.name.endsWith(".ts")) into[p] = valueImports(p);
  }
  return into;
}

test("nothing in the approvals spine sits in an import cycle", () => {
  const g = graph(SRC);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const walk = (n: string) => {
    const at = stack.indexOf(n);
    if (at >= 0) { cycles.push([...stack.slice(at), n]); return; }
    if (seen.has(n)) return;
    seen.add(n); stack.push(n);
    for (const d of g[n] ?? []) walk(d);
    stack.pop();
  };
  for (const n of Object.keys(g)) { seen.clear(); stack.length = 0; walk(n); }

  const offending = cycles
    .filter((c) => c.some((f) => SPINE.includes(f.slice(SRC.length + 1))))
    .map((c) => c.map((f) => f.slice(SRC.length + 1)).join(" -> "));
  assert.deepEqual([...new Set(offending)], [],
    "the filing path must not import its way back into the routing layer — see the note above");
});
