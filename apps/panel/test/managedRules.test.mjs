import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesAMoveWouldArm, whyNotActing } from "../lib/managedRules.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

test("a managed rule says which of four things stops it — its own switch is only one of them", () => {
  assert.equal(whyNotActing(null, NOW), "deleted");
  assert.equal(whyNotActing({ id: "r", enabled: false }, NOW), "off");
  assert.equal(whyNotActing({ id: "r", enabled: true, sectionOff: true }, NOW), "section");
  assert.equal(whyNotActing({ id: "r", enabled: true, pausedUntil: "2026-10-08T14:00:00Z" }, NOW), "paused");
  assert.equal(whyNotActing({ id: "r", enabled: true, pausedUntil: "2026-10-08T11:00:00Z" }, NOW), null, "a pause that has run out is no pause");
  assert.equal(whyNotActing({ id: "r", enabled: true, sectionOff: false, pausedUntil: null }, NOW), null);
  // Its own switch first: switched off AND in an off section is fixed by switching it on first.
  assert.equal(whyNotActing({ id: "r", enabled: false, sectionOff: true }, NOW), "off");
});

test("a move arms only the rules a switched-off section was holding, and only when they land somewhere that holds nothing", () => {
  const sections = [{ id: "off", enabled: false }, { id: "on", enabled: true }, { id: "off2", enabled: false }];
  const rules = [
    { id: "held", name: "held", enabled: true, sectionOff: true, sectionId: "off" },
    { id: "ownOff", name: "ownOff", enabled: false, sectionOff: true, sectionId: "off" },
    { id: "live", name: "live", enabled: true, sectionOff: false, sectionId: "on" },
  ];
  const all = new Set(rules.map((r) => r.id));
  assert.deepEqual(rulesAMoveWouldArm(rules, all, "on", sections).map((r) => r.id), ["held"], "into a section that is on");
  assert.deepEqual(rulesAMoveWouldArm(rules, all, null, sections).map((r) => r.id), ["held"], "to Other rules");
  assert.deepEqual(rulesAMoveWouldArm(rules, all, "off2", sections), [], "into another switched-off section: still held");
  assert.deepEqual(rulesAMoveWouldArm(rules, all, "off", sections), [], "staying where it is");
  assert.deepEqual(rulesAMoveWouldArm(rules, new Set(["live"]), null, sections), [], "a rule nothing held arms nothing new");
});
