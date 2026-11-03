/**
 * The scheduled events post names events as staff typed them: the worker hands the post builder
 * Discord's escaping, the same as the panel's "Post now". The post itself is made inside the
 * worker's loop, which a test cannot start, so this reads the source — the builder's own tests
 * (@app/payout) and the route's (apps/api) cover what the escaping does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the scheduled events post escapes event names, like Post now", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function postEventsList(");
  assert.ok(start >= 0, "the scheduled post is where it was");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /buildEventsPost\(events, \{[^}]*literal: discordLiteral,/, "the post builder gets Discord's escaping");
});
