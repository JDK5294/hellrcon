import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// From dist, like the other tests that need the whole route graph loaded.
import { createHandler, createAppContext } from "../dist/app.js";
import { PLAIN_WRITES, REPLAYABLE_WRITES } from "../dist/routes/kit.js";
import { NOT_ASKABLE, ROUTE_ASK_LABELS } from "../dist/ask.js";
import { createIsolatedRepository } from "@app/db";

/**
 * Every server-scoped WRITE is requestable, and every one of them says what it is.
 *
 * The wrapper files a refused call as a request; the queue then has to render it for somebody who
 * was not there. "POST /api/servers/:id/mapvote/skip" is not a line anybody should be asked to
 * sign, so each route carries a label — and the two lists are held to each other in BOTH
 * directions, because a route added without one files requests that read as a URL, and a label
 * outliving its route is a promise about something the app can no longer do.
 */
test("every replayable write route has a plain-words label, and every label has a route", async () => {
  // The registry fills as the route modules load, so build the app before reading it.
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  createHandler(ctx);
  try {
    const routes = [...REPLAYABLE_WRITES.keys()].sort();
    assert.ok(routes.length >= 25, `expected the server-scoped writes to be registered, found ${routes.length}`);
    // Every write that can be asked for: the server wrapper's, and the plain routes not set aside.
    const askable = new Set([...routes, ...[...PLAIN_WRITES].filter(([, handler]) => handler !== null).map(([key]) => key)]);
    const labelled = Object.keys(ROUTE_ASK_LABELS).sort();
    const missing = [...askable].filter((r) => !ROUTE_ASK_LABELS[r]).sort();
    assert.deepEqual(missing, [], "these write routes would file a request that reads as a URL — give them a label in ask.ts, or say in NOT_ASKABLE why they are never asked for");
    const stale = labelled.filter((r) => !askable.has(r));
    assert.deepEqual(stale, [], "these labels name routes that no longer exist (or are set aside in NOT_ASKABLE)");
  } finally { await cleanup(); }
});

/**
 * EVERY write a role can be granted asks — the owner's rule: everything a role can see, it can
 * request. So a write is either labelled (and asks) or set aside in NOT_ASKABLE with the reason
 * written down; nothing slips out of the approvals surface by being typed as a bare route.
 */
test("every write is either asked for or set aside with a reason, and every reason names a real write", async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  createHandler(ctx);
  try {
    const plain = [...PLAIN_WRITES.keys()];
    assert.ok(plain.length >= 150, `expected the plain write routes to be registered, found ${plain.length}`);
    const setAside = [...PLAIN_WRITES].filter(([, handler]) => handler === null).map(([key]) => key).sort();
    assert.deepEqual(setAside, Object.keys(NOT_ASKABLE).filter((k) => PLAIN_WRITES.has(k)).sort(), "a write set aside is set aside by NOT_ASKABLE, nothing else");
    const unknown = Object.keys(NOT_ASKABLE).filter((k) => !PLAIN_WRITES.has(k)).sort();
    assert.deepEqual(unknown, [], "these NOT_ASKABLE entries name writes that do not exist");
    for (const [key, reason] of Object.entries(NOT_ASKABLE)) assert.ok(reason.trim().length > 0, `${key} needs its reason written down`);
    // The owner's example, by name: adding someone to a group is asked for.
    assert.ok(ROUTE_ASK_LABELS["POST /api/player-groups/:id/members"], "group membership can be requested");
  } finally { await cleanup(); }
});

/**
 * ...and the wrapper is the ONLY way a server operation is written.
 *
 * The test above compares two lists that both describe routes which already went through
 * `serverRoute`. A write typed as a bare `route(...)` appears in neither, so it silently opts out
 * of the whole approvals surface — no filing, no capture into a request, no queue line — and
 * nothing notices. That is exactly how "change one auto-settings rule" ended up the single server
 * operation in the app that a moderator could not ask for.
 *
 * The four modules below are wholly about operating a server, so the rule for them is absolute.
 * `servers.ts` and `ingest.ts` are deliberately not here: they also carry installation and import
 * work (connection details, the CRCON import, purges) plus the player-action filing path, which
 * are not the wrapper's business.
 */
test("server operations are written through the wrapper, so none can escape being requestable", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
  const offenders: string[] = [];
  for (const file of ["maps.ts", "automation.ts", "admin-cam.ts", "discord.ts"]) {
    const src = readFileSync(join(dir, file), "utf8");
    // A bare `route(` at the start of a call — `serverRoute(` does not match, because the capture
    // demands either the line start or a character that cannot be part of an identifier.
    for (const m of src.matchAll(/(^|[^A-Za-z0-9_.])route\(\s*"(POST|PUT|PATCH|DELETE)",\s*"(\/api\/servers\/:id\/[^"]*)"/g)) {
      offenders.push(`${file}: ${m[2]} ${m[3]}`);
    }
  }
  assert.deepEqual(offenders, [], "these server-scoped writes bypass serverRoute, so they cannot be asked for — convert them");
});
