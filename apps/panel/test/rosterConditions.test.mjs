// The Player triggers builder's roster conditions, held to the server's.
//
// The panel imports no workspace packages, so it keeps its own copy of which conditions exist and
// which Rules trigger judges each. If the copy drifts, the builder offers a condition the API
// refuses (or sets it up with the wrong trigger's form), and that only shows at Save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROSTER_CLEAR_MINUTES, ROSTER_CONDITIONS, ROSTER_DEFAULTS } from "../lib/rosterConditions.ts";

const source = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the builder offers exactly the roster conditions the API takes, each with the same Rules trigger", () => {
  const rules = source("../../../packages/rules/src/player-roster.ts");
  const block = /export const PLAYER_ROSTER_EVENT_KIND = \{([^}]*)\}/.exec(rules);
  assert.ok(block, "the rules package names its conditions");
  const api = Object.fromEntries([...block[1].matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.fromEntries(ROSTER_CONDITIONS.map((c) => [c.id, c.kind])), api);
  assert.deepEqual(Object.keys(ROSTER_DEFAULTS).sort(), Object.keys(api).sort(), "every condition starts from defaults");
  const clear = /export const ROSTER_TRIGGER_CLEAR_MS = ([\d_]+);/.exec(rules);
  assert.ok(clear, "the rules package names how long a condition must be gone");
  assert.equal(ROSTER_CLEAR_MINUTES * 60_000, Number(clear[1].replaceAll("_", "")), "the hint's minutes are the worker's");
});

test("a condition starts from its Rules trigger's own defaults", () => {
  const editor = source("../components/Enforcer.tsx");
  for (const c of ROSTER_CONDITIONS) {
    if (c.id === "role") continue; // a role list alone: the restricted-role trigger's allowlist half is not offered
    const m = new RegExp(`"${c.kind.replaceAll(".", "\\.")}": (\\{[^}]*\\})`).exec(editor);
    assert.ok(m, `the rule editor starts ${c.kind} from defaults`);
    // The rule editor's object literal, read as JSON once its keys are quoted (a key follows "{" or
    // ","; the ratio's "teamkills:kills" is a value, and keeps its colon).
    const defaults = JSON.parse(m[1].replace(/([{,]\s*)(\w+):/g, '$1"$2":'));
    assert.deepEqual(ROSTER_DEFAULTS[c.id], defaults, `${c.id} starts where a ${c.kind} rule does`);
  }
});

test("the ratio check offers exactly the ratios the API takes", () => {
  const counts = /export const RATIO_COUNTS = \[([^\]]*)\]/.exec(source("../../../packages/rules/src/state-triggers.ts"));
  assert.ok(counts, "the rules package names the counts a ratio sets against each other");
  const names = [...counts[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const api = names.flatMap((a) => names.filter((b) => b !== a).map((b) => `${a}:${b}`)).sort();
  const choices = /const RATIO_CHOICES = \[([\s\S]*?)\];/.exec(source("../components/StateTriggerParams.tsx"));
  assert.ok(choices, "the shared form lists its ratios");
  assert.deepEqual([...choices[1].matchAll(/value: "([^"]+)"/g)].map((m) => m[1]).sort(), api);
});

test("the rule editor and Player triggers set up a roster trigger with one shared form", () => {
  assert.match(source("../components/Enforcer.tsx"), /return <StateTriggerParams kind=\{kind\} value=\{value\} onChange=\{onChange\} \/>;/);
  const builder = source("../components/PlayerTriggers.tsx");
  assert.match(builder, /<StateTriggerParams kind=\{rosterKindOf\(event\)\} value=\{condition\} onChange=\{setCondition\} roles=\{playerGame\?\.roles \?\? \{\}\} \/>/,
    "Player triggers passes the PLAYER's game's roles, not the selected server's");
});
