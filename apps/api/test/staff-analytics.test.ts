import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// From dist, not src: staff-analytics.ts now imports its sibling analytics.js, and strip-types
// cannot resolve a .js specifier back to a .ts source — the same reason the games tests read dist.
import { categorizeAction, buildStaffAnalytics, STAFF_CATEGORIES, RESIDUAL_CATEGORY } from "../dist/staff-analytics.js";
import type { AuditRow } from "@app/db";

function row(p: Partial<AuditRow>): AuditRow {
  return {
    id: Math.random().toString(36).slice(2), ts: "2026-07-01T00:00:00.000Z", actorUserId: "u1", actorName: "AdminJoe",
    action: "player.tempban", targetType: "player", targetId: null, targetName: null, serverId: null, summary: "", data: null, automated: false,
    ...p,
  };
}

test("categorizeAction: maps dotted verbs to coarse categories", () => {
  assert.equal(categorizeAction("player.tempban"), "bans");
  assert.equal(categorizeAction("player.permaban"), "bans");
  assert.equal(categorizeAction("player.kick"), "kicks");
  assert.equal(categorizeAction("vip.grant"), "vips");
  // A blacklist entry is a ban decision in this app's model (docs/ban-model.md), and is counted
  // with the bans rather than as its own kind of work.
  assert.equal(categorizeAction("blacklist.add"), "bans");
  assert.equal(categorizeAction("broadcast.send"), "messages");
  assert.equal(categorizeAction("player.switch"), "moves");
  assert.equal(categorizeAction("note.create"), "other");
});

test("buildStaffAnalytics: totals, categories, top targets/servers, daily series", () => {
  const rows: AuditRow[] = [
    row({ action: "player.tempban", targetId: "111", targetName: "Cheater", serverId: "s1", ts: "2026-07-01T10:00:00Z" }),
    row({ action: "player.permaban", targetId: "111", targetName: "Cheater", serverId: "s1", ts: "2026-07-01T11:00:00Z" }),
    row({ action: "player.kick", targetId: "222", targetName: "Troll", serverId: "s2", ts: "2026-07-02T09:00:00Z" }),
    row({ action: "vip.grant", targetId: "333", targetName: "Donor", serverId: "s1", ts: "2026-07-02T12:00:00Z" }),
  ];
  const a = buildStaffAnalytics(rows);

  assert.equal(a.total, 4);
  assert.equal(a.firstAt, "2026-07-01T10:00:00Z");
  assert.equal(a.lastAt, "2026-07-02T12:00:00Z");
  assert.equal(a.byCategory.bans, 2);
  assert.equal(a.byCategory.kicks, 1);
  assert.equal(a.byCategory.vips, 1);
  assert.equal(a.byAction["player.tempban"], 1);

  // player 111 is the most-actioned target (2 bans).
  assert.equal(a.topTargets[0]!.id, "111");
  assert.equal(a.topTargets[0]!.count, 2);
  // s1 has the most actions (3).
  assert.equal(a.topServers[0]!.serverId, "s1");
  assert.equal(a.topServers[0]!.count, 3);

  // two day-buckets, chronological, with per-category counts.
  assert.deepEqual(a.daily.map((d) => d.date), ["2026-07-01", "2026-07-02"]);
  assert.equal(a.daily[0]!.byCategory.bans, 2);
  assert.equal(a.daily[1]!.total, 2);
});

test("buildStaffAnalytics: empty trail", () => {
  const a = buildStaffAnalytics([]);
  assert.equal(a.total, 0);
  assert.equal(a.firstAt, null);
  assert.deepEqual(a.topTargets, []);
  assert.deepEqual(a.daily, []);
});

test("a punish is a penalty, not a message", () => {
  // `punish` sat inside the messages regex, so every punishment a staff member handed out was
  // counted and drawn as a message they had sent — the one action most likely to be the bulk of a
  // busy moderator's night, filed under the wrong heading.
  assert.equal(categorizeAction("player.punish"), "punishments");
  assert.equal(categorizeAction("broadcast.send"), "messages", "real messages are unaffected");
  assert.equal(categorizeAction("player.message"), "messages");
});

test("the panel's category list mirrors this one, in the same order", () => {
  /**
   * The panel has no workspace dependency on the API, so it hand-copies STAFF_CATEGORIES — and the
   * ORDER is load-bearing: it is the colour-slot order behind the breakdown and radar. A category
   * added here and forgotten there is a bar that silently never draws; one inserted rather than
   * appended repaints every existing series.
   */
  const src = readFileSync(new URL("../../panel/components/StaffProfile.tsx", import.meta.url), "utf8");
  const line = /const CATS = \[([^\]]*)\] as const;/.exec(src);
  assert.ok(line, "could not find CATS in StaffProfile.tsx — if it was renamed, update this test");
  const mirrored = [...line[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(mirrored, STAFF_CATEGORIES, "the panel's copy of the staff categories has drifted");
});

test("approval paperwork is its own category, not a ban and not 'other'", () => {
  /**
   * An approver's every signature used to land in "other" — and, worse, the action they signed off
   * was credited to THEM, so their profile read as a moderator's. Both halves are fixed: the
   * executed action is the requester's (approvals.ts), and the paperwork is its own bar.
   */
  assert.equal(categorizeAction("request.approve"), "requests");
  assert.equal(categorizeAction("request.deny"), "requests");
  assert.equal(categorizeAction("request.file"), "requests");
  assert.equal(categorizeAction("request.withdraw"), "requests");
  // The verb after `request.` is paperwork, not the action: approving a ban is not banning.
  assert.equal(categorizeAction("request.approve.tempban"), "requests");
  // …and a real ban is still a ban.
  assert.equal(categorizeAction("player.tempban"), "bans");
});

test("top targets are players, not request ids", () => {
  /**
   * The panel draws each of these as a player link. A request's audit row targets the REQUEST, so
   * filing five requests put five raw uuids — with dead links — above the player they were about.
   */
  const a = buildStaffAnalytics([
    row({ action: "request.file", targetType: "request", targetId: "bf5569a7-c967-4a3a-9d0e-000000000001" }),
    row({ action: "request.file", targetType: "request", targetId: "bf5569a7-c967-4a3a-9d0e-000000000002" }),
    row({ action: "request.approve", targetType: "request", targetId: "bf5569a7-c967-4a3a-9d0e-000000000003" }),
    row({ action: "role.update", targetType: "role", targetId: "moderator", targetName: "Moderator" }),
    row({ action: "player.kick", targetType: "player", targetId: "111", targetName: "LinkedFall7060" }),
  ]);
  assert.deepEqual(a.topTargets.map((t) => t.name), ["LinkedFall7060"]);
  assert.equal(a.total, 5, "the rows still count — they are just not TARGETS");
  assert.equal(a.byCategory.requests, 3);
});

test("the categories fit the palette they are drawn with", () => {
  /**
   * The panel draws these as a breakdown and a radar, colouring each by its INDEX in this list,
   * and the validated categorical palette has seven slots — `seriesVar` folds anything past the
   * seventh into slot 7 rather than inventing a hue. An eighth HUED category is therefore not a new
   * colour: it is two differently-labelled series drawn in the same one, which a reader cannot
   * tell apart and which no amount of legend fixes.
   *
   * The residual bucket is the one exception, and only because it is drawn in neutral ink rather
   * than a hue (`seriesVar(RESIDUAL_INDEX)`) — which is why it must stay LAST, where the panel's
   * `catColor` expects it.
   *
   * Read from the stylesheet rather than hard-coded, so adding `--series-8` (validated, in BOTH
   * themes) is what unlocks an eighth hued category — in that order.
   */
  const css = readFileSync(new URL("../../panel/app/globals.css", import.meta.url), "utf8");
  const slots = new Set([...css.matchAll(/--series-(\d+)\s*:/g)].map((m) => Number(m[1])));
  assert.ok(slots.size >= 7, `expected the series palette in globals.css, found ${slots.size} slots`);
  assert.equal(STAFF_CATEGORIES.at(-1), RESIDUAL_CATEGORY, "the residual category must be last — it is the one drawn without a hue");
  const hued = STAFF_CATEGORIES.filter((c: string) => c !== RESIDUAL_CATEGORY);
  assert.ok(hued.length <= slots.size,
    `${hued.length} hued staff categories against ${slots.size} palette slots — the last ${hued.length - slots.size} would share slot ${slots.size}`);

  // …and the panel really does paint the residual one neutral, rather than handing it slot 8.
  const tsx = readFileSync(new URL("../../panel/components/StaffProfile.tsx", import.meta.url), "utf8");
  assert.match(tsx, /catColor = \(c: Cat, i: number\) => \(c === "other" \? RESIDUAL_INDEX : i\)/);
});
