/**
 * The relay's event vocabulary has to keep up with the store's.
 *
 * `formatEvent` returns null for a kind it does not know, and null means "silently not relayed" —
 * there is no error, no log line, nothing to notice. So the relay had quietly fallen two kinds
 * behind: `evt.admin.camera` and `evt.vote.cast` were being stored, shown in the panel's game log,
 * and counted in analytics, but never reached Discord. Those same two kinds had already been found
 * missing in four other places, which is what makes a guard worth more than another one-off fix.
 *
 * A kind that genuinely should not be relayed belongs in NOT_RELAYED below with a reason, so the
 * next kind added to the store has to be a decision rather than an oversight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_KINDS } from "@app/db";
import { categoryOf, formatEvent, ALL_CATEGORIES, RELAYED_KINDS } from "../dist/format.js";

/** Kinds deliberately outside the relay. Empty today — the two noisy ones are relayed but filtered
 *  by `includeVoteBallots` instead, which keeps the choice visible in the panel. */
const NOT_RELAYED = new Set<string>();

test("every event kind the store can hold is either relayed or explicitly excluded", () => {
  const unhandled = EVENT_KINDS.filter((k) => !NOT_RELAYED.has(k) && categoryOf(k) === null);
  assert.deepEqual(unhandled, [], `these kinds are stored but never reach Discord: ${unhandled.join(", ")}`);
});

test("every relayed kind renders a message body, not just a category", () => {
  // A kind mapped to a category but missing from the body switch is the same silent drop, one
  // step later: formatEvent returns null and nothing is posted.
  const bodyless = EVENT_KINDS.filter((k) => {
    if (NOT_RELAYED.has(k)) return false;
    return formatEvent({ kind: k, actorName: "A", victimName: "B", data: { message: "m", content: "c", result: "r" } }) === null;
  });
  assert.deepEqual(bodyless, [], `these kinds route to a channel but render nothing: ${bodyless.join(", ")}`);
});

test("the relay does not route kinds the store cannot produce", () => {
  // A mistyped kind string here would simply never match an event — no error, no clue.
  const known = new Set<string>(EVENT_KINDS);
  const strays = RELAYED_KINDS.filter((k) => !known.has(k));
  assert.deepEqual(strays, [], `these kinds are routed but never emitted: ${strays.join(", ")}`);
});

test("every kind lands in one of the categories the panel offers", () => {
  const cats = new Set<string>(ALL_CATEGORIES);
  for (const k of EVENT_KINDS) {
    const c = categoryOf(k);
    if (c === null) continue;
    assert.ok(cats.has(c), `${k} routes to "${c}", which is not a category staff can configure`);
  }
});
