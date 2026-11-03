/**
 * The role gate on the public Discord panel, as a pair of pure functions.
 *
 * `claimAllowed` decides whether a gated thing is offered; `gateDiagnosis` says WHY it was not, so
 * the log can separate the two cases that look identical from outside — someone who lacks the role
 * (correct, and silent on purpose) from an interaction that carried no roles at all (a fault that
 * hides every gated feature at once). Both were reachable only through a rendered panel, and the
 * property that matters most is the one a refactor is most likely to invert: an interaction with
 * NO roles must be refused, not waved through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimAllowed, gateDiagnosis } from "../dist/discord-public.js";

const GATED = { roleIds: ["r-donor", "r-staff"] };
const UNGATED = { roleIds: [] };

test("an ungated claim is open to everyone, roles or no roles", () => {
  assert.equal(claimAllowed(UNGATED, ["r-nobody"]), true);
  assert.equal(claimAllowed(UNGATED, []), true);
  assert.equal(claimAllowed(UNGATED, undefined), true);
  assert.equal(claimAllowed({}, undefined), true, "no roleIds key at all is ungated, not broken");
  // And it proves nothing about gating — the empty list short-circuits before roles are consulted.
  assert.equal(gateDiagnosis(UNGATED, undefined), "ungated");
});

test("a gated claim needs one of its roles, and NO roles is a refusal", () => {
  assert.equal(claimAllowed(GATED, ["r-donor"]), true, "any one of the listed roles is enough");
  assert.equal(claimAllowed(GATED, ["r-other", "r-staff"]), true);
  assert.equal(claimAllowed(GATED, ["r-other"]), false);
  assert.equal(claimAllowed(GATED, []), false);
  // The one that must never flip: an interaction that carried no roles cannot demonstrate the
  // role, so it is refused. Reading it as "no restrictions apply" would open every gated claim in
  // the panel to anyone whose press arrived without a member object.
  assert.equal(claimAllowed(GATED, undefined), false, "no roles seen is refused, never waved through");
});

test("the diagnosis separates lacking the role from never seeing any", () => {
  assert.equal(gateDiagnosis(GATED, ["r-donor"]), "allowed");
  assert.equal(gateDiagnosis(GATED, ["r-other"]), "lacks-role", "normal, and says nothing on screen");
  assert.equal(gateDiagnosis(GATED, []), "no-roles-seen");
  assert.equal(gateDiagnosis(GATED, undefined), "no-roles-seen", "the fault worth logging");
  // Both refusals agree with the gate itself — a diagnosis that disagreed with the decision it
  // explains would send whoever is debugging in the wrong direction.
  for (const held of [["r-other"], [], undefined]) {
    assert.equal(claimAllowed(GATED, held), false, `gate and diagnosis must agree for ${JSON.stringify(held)}`);
  }
});
