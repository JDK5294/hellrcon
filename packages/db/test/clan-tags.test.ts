/**
 * One main tag for every spelling of it: the automatic fold, and the choices staff make on top
 * (combine, split, reset, rename) — read back the way the Clans tab and the rules trigger read it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAN_TAG_SETTINGS_DEFAULTS, clanCombineTarget, clanFoldKey, clanGroupCustomised, clanGroupOf, clanLabel, clanResolveKey,
  combineClanGroups, groupClanSpellings, normalizeClanTagSettings, renameClanGroup, resetClanGroup, splitClanSpelling,
} from "../dist/index.js";

test("the styling comes off: brackets, small capitals, fancy alphabets, lookalikes and accents fold to one key", () => {
  for (const s of ["[KLM]", "KLM", "klm", "ᴋʟᴍ", "K.L.M", "𝕂𝕃𝕄★", "ＫＬＭ", "ⓀⓁⓂ", "🅺🅻🅼", "🇰🇱🇲", "КLМ", "K̶L̶M̶", "|KLM|", " =KLM= "]) {
    assert.equal(clanFoldKey(s), "klm", `${s} should fold to klm`);
  }
  assert.equal(clanFoldKey("ǫᴜɪᴄᴋ"), "quick", "the generators' small-capital q is a q, not an o");
  assert.equal(clanFoldKey("Équipe"), "equipe");
  assert.equal(clanFoldKey("101st"), "101st", "digits are kept as they are");
  assert.notEqual(clanFoldKey("82nd"), clanFoldKey("82"), "a digit difference stays a difference");
  assert.equal(clanFoldKey("ВДВ"), clanFoldKey("[ВДВ]"), "a tag in another script still folds alike");
  // Symbols only: kept as typed, so two different emblems never collapse into one empty key.
  assert.notEqual(clanFoldKey("★★"), clanFoldKey("☠☠"));
  assert.equal(clanFoldKey("★★"), clanFoldKey(" ★★ "));
});

test("combine, split, reset and rename — and what a saved key reads as afterwards", () => {
  const spellings = ["[KLM]", "ᴋʟᴍ", "KLM", "LYNX", "[LYNX]", "RIVAL"];
  let s = CLAN_TAG_SETTINGS_DEFAULTS;
  const groups = () => Object.fromEntries([...groupClanSpellings(s, spellings)].map(([k, v]) => [k, [...v].sort()]));
  assert.deepEqual(groups(), { klm: ["KLM", "[KLM]", "ᴋʟᴍ"], lynx: ["LYNX", "[LYNX]"], rival: ["RIVAL"] });

  // A sister tag shares no letters with the main one: staff combine them.
  s = combineClanGroups(s, ["klm", "lynx"], "The Lynx Division");
  assert.deepEqual(groups(), { klm: ["KLM", "LYNX", "[KLM]", "[LYNX]", "ᴋʟᴍ"], rival: ["RIVAL"] });
  assert.equal(clanResolveKey(s, "lynx"), "klm", "a rule saved on the absorbed group follows it");
  assert.equal(clanLabel(s, "klm", []), "The Lynx Division");
  assert.equal(clanGroupCustomised(s, "klm"), true);
  assert.equal(clanGroupCustomised(s, "rival"), false);

  // One spelling that does not belong: split it out. It is a clan of its own, and stays so.
  s = splitClanSpelling(s, "[LYNX]");
  assert.deepEqual(groups(), { klm: ["KLM", "LYNX", "[KLM]", "ᴋʟᴍ"], "s:[LYNX]": ["[LYNX]"], rival: ["RIVAL"] });
  assert.equal(clanGroupOf(s, "[LYNX]"), "s:[LYNX]");
  assert.equal(clanResolveKey(s, "s:[LYNX]"), "s:[LYNX]");

  // Combining into the split one carries it along; no lookup ever follows a chain.
  s = combineClanGroups(s, ["rival", "s:[LYNX]"]);
  assert.deepEqual(groups(), { klm: ["KLM", "LYNX", "[KLM]", "ᴋʟᴍ"], rival: ["RIVAL", "[LYNX]"] });
  assert.ok(Object.values(s.merges).every((v) => !(("k:" + v) in s.merges) || s.merges["k:" + v] === v), "every entry names a final group");

  // Reset undoes what made the group: [LYNX] rejoins its automatic group (lynx, itself combined into klm).
  s = resetClanGroup(s, "rival");
  assert.deepEqual(groups(), { klm: ["KLM", "LYNX", "[KLM]", "[LYNX]", "ᴋʟᴍ"], rival: ["RIVAL"] });
  s = resetClanGroup(s, "klm");
  assert.deepEqual(groups(), { klm: ["KLM", "[KLM]", "ᴋʟᴍ"], lynx: ["LYNX", "[LYNX]"], rival: ["RIVAL"] });
  assert.equal(clanResolveKey(s, "lynx"), "lynx", "and the absorbed group is its own again");
  assert.deepEqual(s, { merges: {}, labels: {} }, "nothing left behind");

  // A name, and an empty name back to the most-worn spelling.
  s = renameClanGroup(s, "rival", "Rivals");
  assert.equal(clanLabel(s, "rival", []), "Rivals");
  s = renameClanGroup(s, "rival", "  ");
  assert.equal(clanLabel(s, "rival", [{ tag: "RIVAL", ever: 4, lastSeen: null }, { tag: "rival", ever: 9, lastSeen: null }]), "rival");
});

test("stored settings are read defensively", () => {
  assert.deepEqual(normalizeClanTagSettings(null), { merges: {}, labels: {} });
  assert.deepEqual(normalizeClanTagSettings({ merges: { "k:a": "b", "k:x": 3 }, labels: [] }), { merges: { "k:a": "b" }, labels: {} });
});

test("a split spelling never anchors a combined clan it could not leave; the one that does hands the clan on", () => {
  const spellings = ["[KLM]", "KLM", "LYNX", "Lynx."];
  const groups = (s: typeof CLAN_TAG_SETTINGS_DEFAULTS) => Object.fromEntries([...groupClanSpellings(s, spellings)].map(([k, v]) => [k, [...v].sort()]));
  // [KLM] split out, then combined with LYNX — ticked first. An automatic group stays, so the
  // spelling can be split out again later.
  let s = splitClanSpelling(CLAN_TAG_SETTINGS_DEFAULTS, "[KLM]");
  assert.equal(clanCombineTarget(["s:[KLM]", "lynx"]), "lynx");
  s = combineClanGroups(s, ["s:[KLM]", "lynx"], "Lynxes");
  assert.deepEqual(groups(s), { lynx: ["LYNX", "Lynx.", "[KLM]"], klm: ["KLM"] });
  s = splitClanSpelling(s, "[KLM]");
  assert.deepEqual(groups(s), { "s:[KLM]": ["[KLM]"], lynx: ["LYNX", "Lynx."], klm: ["KLM"] }, "splitting it out again really splits it");
  assert.equal(clanLabel(s, "lynx", []), "Lynxes", "the clan keeps its name");

  // Only split spellings combined: one of them must anchor. Splitting the anchor hands the rest —
  // and the name — to the next.
  let t = splitClanSpelling(splitClanSpelling(CLAN_TAG_SETTINGS_DEFAULTS, "LYNX"), "Lynx.");
  t = combineClanGroups(t, ["s:LYNX", "s:Lynx."], "Pack");
  assert.deepEqual(groups(t), { "s:LYNX": ["LYNX", "Lynx."], klm: ["KLM", "[KLM]"] });
  t = splitClanSpelling(t, "LYNX");
  assert.deepEqual(groups(t), { "s:LYNX": ["LYNX"], "s:Lynx.": ["Lynx."], klm: ["KLM", "[KLM]"] });
  assert.equal(clanLabel(t, "s:Lynx.", []), "Pack");
  assert.equal(clanLabel(t, "s:LYNX", []), "LYNX");
});
