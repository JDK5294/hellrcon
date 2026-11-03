/**
 * No route is unreachable.
 *
 * The dispatcher tries routes in registration order and the FIRST pattern that matches wins, so a
 * literal path registered after a `:param` route with the same shape can never be reached — the
 * request lands in the param route instead and 404s from inside it. `/api/requests/draft` sitting
 * behind `/api/requests/:id` is exactly that, and the only thing keeping it right was a comment.
 *
 * This walks the real table: for each route, build the plainest concrete path it would serve, and
 * assert no EARLIER route of the same method already answers that path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routes } from "../dist/app.js";

/** A concrete request path this route is meant to serve: its own literals, params filled in. */
function sample(pattern: RegExp): string {
  // The compiled pattern is "^<path with ([^/]+) for each :param, (/.+) for a trailing /*rest>$"
  // — reversing it is exact, because those are the only substitutions `route()` makes.
  let n = 0;
  return pattern.source
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\(\[\^\\?\/\]\+\)/g, () => `p${++n}`)
    .replace(/\(\\\/\.\+\)$/, () => `/p${++n}`)
    // `RegExp.source` escapes the slashes on the way out; nothing else in a route path is
    // escaped, because `route()` substitutes the params and takes the rest verbatim.
    .replace(/\\\//g, "/");
}

/** The walk itself, so the same code can be pointed at a table known to be broken. */
function shadowedIn(table: { method: string; pattern: RegExp }[]): string[] {
  const shadowed: string[] = [];
  for (let i = 0; i < table.length; i++) {
    const r = table[i]!;
    const path = sample(r.pattern);
    // A route must at least match its own sample, or this walk proves nothing.
    assert.ok(r.pattern.test(path), `could not build a sample path for ${r.method} ${r.pattern.source}`);
    for (let j = 0; j < i; j++) {
      const earlier = table[j]!;
      if (earlier.method !== r.method) continue;
      if (earlier.pattern.test(path)) {
        shadowed.push(`${r.method} ${path} (this route, #${i}) is answered first by #${j} ${earlier.pattern.source}`);
        break;
      }
    }
  }
  return shadowed;
}

test("the walk finds a route buried behind a :param route", () => {
  // The real table below passes, so this proves the check can fail — the exact arrangement it
  // exists to prevent, which the live table only avoids by keeping the literals first.
  const found = shadowedIn([
    { method: "GET", pattern: /^\/api\/requests\/([^/]+)$/ },
    { method: "GET", pattern: /^\/api\/requests\/draft$/ },
  ]);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0]!, /\/api\/requests\/draft/);
  // Order is the whole point: literal first, and there is nothing to report.
  assert.deepEqual(shadowedIn([
    { method: "GET", pattern: /^\/api\/requests\/draft$/ },
    { method: "GET", pattern: /^\/api\/requests\/([^/]+)$/ },
  ]), []);
  // A different method never shadows.
  assert.deepEqual(shadowedIn([
    { method: "POST", pattern: /^\/api\/requests\/([^/]+)$/ },
    { method: "GET", pattern: /^\/api\/requests\/draft$/ },
  ]), []);
});

test("every route is reachable — none is shadowed by an earlier :param route", () => {
  assert.ok(routes.length > 100, `expected the whole route table, got ${routes.length}`);
  assert.deepEqual(shadowedIn(routes), [], "these routes can never be reached — register the literal paths before the :param ones");
});

/**
 * ...and every route pattern means what its path says.
 *
 * `route()` builds its regex by substituting `:param` and taking the rest of the path VERBATIM —
 * nothing is escaped. Every path is plain today, so that is invisible; the day somebody registers
 * `/api/export/data.json`, the dot becomes "any character" and `/api/export/dataXjson` answers
 * too. Cheap to notice here, very hard to notice in the field.
 */
test("no route path smuggles a regex metacharacter past the compiler", () => {
  const loose: string[] = [];
  for (const r of routes) {
    const path = sample(r.pattern);
    for (let i = 0; i < path.length; i++) {
      const ch = path[i]!;
      if (/[A-Za-z0-9/_-]/.test(ch)) continue;
      // Swap the suspicious character for a letter: a properly escaped literal stops matching.
      const swapped = `${path.slice(0, i)}Z${path.slice(i + 1)}`;
      if (r.pattern.test(swapped)) loose.push(`${r.method} ${path} — '${ch}' is matching any character`);
    }
  }
  assert.deepEqual(loose, [], "escape these in route() or rename the path — the pattern is looser than it reads");
});
