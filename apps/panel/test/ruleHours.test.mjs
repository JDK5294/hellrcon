// The rule editor's Ban-hours decision, held over the WHOLE ladder.
//
// One rule-level `hours` serves every step of a rule — the enforcer reads it for the base action
// and for each escalation rung. The field bug this pins down: with a ladder like "message, then
// ban" the editor never offered the hours field (it only looked at the first action and at
// tempban rungs), so every ladder ban was silently permanent and there was no way to set the
// removal hours the ban's own label promises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { banHoursMode, ruleHoursForSave } from "../lib/ruleHours.ts";

test("a full-ban LADDER step gets the optional hours field — the field bug", () => {
  // "message, then ban": no tempban anywhere, ban only as a rung.
  assert.equal(banHoursMode("message", ["message", "blacklist"]), "optional");
  // Typed hours reach the save (the ladder's ban becomes a temp removal)…
  assert.equal(ruleHoursForSave("message", ["message", "blacklist"], "48"), 48);
  // …and blank still reads permanent, matching the action's own label.
  assert.equal(ruleHoursForSave("message", ["message", "blacklist"], ""), null);
});

test("tempban anywhere on the ladder requires hours, defaulted like the editor", () => {
  assert.equal(banHoursMode("tempban", []), "required");
  assert.equal(banHoursMode("warn", ["tempban"]), "required");
  assert.equal(ruleHoursForSave("warn", ["tempban"], undefined), 2);
  assert.equal(ruleHoursForSave("warn", ["tempban"], "6"), 6);
  // A cleared required field saves as 0 on purpose: the API's refusal names the tempban step,
  // instead of a silent default the author never chose.
  assert.equal(ruleHoursForSave("warn", ["tempban"], ""), 0);
});

test("a blacklist FIRST action keeps its optional reading, even with a tempban rung", () => {
  assert.equal(banHoursMode("blacklist", ["tempban"]), "optional");
  assert.equal(ruleHoursForSave("blacklist", ["tempban"], ""), null);
});

test("no banning step anywhere → no field, hours save null", () => {
  assert.equal(banHoursMode("kick", ["message", "punish"]), "none");
  assert.equal(ruleHoursForSave("kick", ["message", "punish"], "12"), null);
  assert.equal(banHoursMode("message", undefined), "none");
});
