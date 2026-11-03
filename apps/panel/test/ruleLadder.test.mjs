// The rule editor's ladder length, held to the API's.
//
// Offences are remembered per player for a rule's forget window, through a kick and a rejoin, and
// once a ladder runs out its last step repeats. Capped at four steps, a ladder like "message,
// message, punish, punish, kick" left a player who kept rejoining to be kicked again for the rest
// of the window, with nowhere to escalate to. The editor and the API both cap the ladder; if they
// disagree, staff are offered a step that only fails when they press Save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_ESCALATION_STEPS } from "../lib/ruleLadder.ts";

const source = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the editor offers exactly as many ladder steps as the API accepts", () => {
  const api = /export const MAX_ESCALATION_STEPS = (\d+);/.exec(source("../../api/src/routes/kit.ts"));
  assert.ok(api, "the API names its ladder ceiling");
  assert.equal(MAX_ESCALATION_STEPS, Number(api[1]));
});

test("a ladder has room past repeated kicks for a ban", () => {
  // The owner's ladder (first action message, then message, punish, punish, kick), then the steps a
  // rejoiner should meet: kicked again, temporarily banned, then permanently.
  const ladder = ["message", "punish", "punish", "kick", "kick", "tempban", "permaban"];
  assert.ok(ladder.length <= MAX_ESCALATION_STEPS, `${ladder.length} steps must fit under the ceiling of ${MAX_ESCALATION_STEPS}`);
});

test("the rule editor stops offering steps at the shared ceiling, not at a number of its own", () => {
  const editor = source("../components/Enforcer.tsx");
  assert.match(editor, /import \{ MAX_ESCALATION_STEPS \} from "\.\.\/lib\/ruleLadder";/);
  assert.match(editor, /\(f\.escalateActions \?\? \[\]\)\.length < MAX_ESCALATION_STEPS && \(/,
    "the '+ escalate on repeat' button is gated on the shared ceiling");
  assert.doesNotMatch(editor, /escalateActions \?\? \[\]\)\.length < \d/, "no literal step limit left in the editor");
});
