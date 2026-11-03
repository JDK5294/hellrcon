import { test } from "node:test";
import assert from "node:assert/strict";
import { badgesForRoles, graphemes, normalizeBadgeEmoji, type RoleBadgeDef } from "../src/types.ts";

const BADGES: RoleBadgeDef[] = [
  { id: "b1", emoji: "🛡️", label: "Community member", roleIds: ["100", "101"] },
  { id: "b2", emoji: "🏆", label: "Tournament team", roleIds: ["200"] },
  { id: "b3", emoji: "", label: "misconfigured — no emoji", roleIds: ["100"] },
];

test("a badge is earned by ANY of its roles, and one player can wear several", () => {
  assert.deepEqual(badgesForRoles(BADGES, ["101"]), [{ emoji: "🛡️", label: "Community member" }]);
  assert.deepEqual(badgesForRoles(BADGES, ["999", "200"]), [{ emoji: "🏆", label: "Tournament team" }]);
  // Both at once, in the order staff defined them — the order is the layout of the marks column.
  assert.deepEqual(badgesForRoles(BADGES, ["100", "200"]).map((b) => b.emoji), ["🛡️", "🏆"]);
});

test("no roles, no badges configured, or an emoji-less badge: nothing rendered", () => {
  assert.deepEqual(badgesForRoles(BADGES, []), []);
  assert.deepEqual(badgesForRoles([], ["100"]), []);
  // The blank-emoji row matches role 100 but renders nothing — an invisible mark is not a mark.
  assert.deepEqual(badgesForRoles([BADGES[2]!], ["100"]), []);
});

test("a blank label still gets a tooltip — a mark that explains nothing on hover is a mystery", () => {
  const noLabel: RoleBadgeDef = { id: "x", emoji: "🎖️", label: "", roleIds: ["300"] };
  assert.deepEqual(badgesForRoles([noLabel], ["300"]), [{ emoji: "🎖️", label: "Community role" }]);
});

/*
 * Emoji are measured and trimmed by GRAPHEME, never by .length.
 *
 * This is the bug an iPhone found: the editor's input carried maxlength=8 and the validator
 * checked `.length > 8`, both of which count UTF-16 code units. A family emoji is 11 units and a
 * flag is 4, so ordinary emoji were either refused outright or — worse — cut in half on the way
 * in. Half an emoji is not a smaller emoji; it is the hatched .notdef box, saved beside a
 * player's name where nobody could tell what it was meant to be.
 */
test("whole emoji survive, however many code units they take", () => {
  for (const e of ["🛡️", "⭐", "👍🏻", "🇺🇸", "🏳️‍🌈", "🧑‍🚀", "👨‍👩‍👧‍👦"]) {
    assert.equal(normalizeBadgeEmoji(e), e, `${e} (${e.length} UTF-16 units) must pass through intact`);
    assert.equal(graphemes(e).length, 1, `${e} is one grapheme, whatever .length says`);
  }
});

test("two emoji are kept, a third is dropped — the cap counts emoji, not characters", () => {
  assert.equal(normalizeBadgeEmoji("🛡️🏆"), "🛡️🏆");
  assert.equal(normalizeBadgeEmoji("🛡️🏆👑"), "🛡️🏆");
  // 22 UTF-16 units, two graphemes: a code-unit cap would have refused this outright.
  assert.equal(normalizeBadgeEmoji("👨‍👩‍👧‍👦👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦👨‍👩‍👧‍👦");
});

test("a value some other length cap already mangled is repaired, never stored broken", () => {
  const lone = (s: string) => /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));
  const dangling = (s: string) => /‍$/.test(s) || /^(?:‍|️|︎)/.test(s);
  // Every possible cut of a ZWJ chain — the shapes maxlength=8 actually produced.
  for (const src of ["👨‍👩‍👧‍👦", "🏳️‍🌈", "🧑‍🚀"]) {
    for (let n = 1; n <= src.length; n++) {
      const fixed = normalizeBadgeEmoji(src.slice(0, n));
      assert.ok(!lone(fixed), `cut ${n} of ${src} left half a surrogate pair: ${JSON.stringify(fixed)}`);
      assert.ok(!dangling(fixed), `cut ${n} of ${src} left a dangling joiner: ${JSON.stringify(fixed)}`);
    }
  }
});

test("surrounding whitespace is not an emoji", () => {
  assert.equal(normalizeBadgeEmoji("  🏆  "), "🏆");
  assert.equal(normalizeBadgeEmoji("   "), "", "blank stays blank so the caller can refuse it");
});
