import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySignature, automatedSignerFrom, fillPlayerToken, parseSignatureActions, signatureUseFor,
  SIGNABLE_ACTIONS, SIGNABLE_ACTION_LABELS,
} from "../src/signature.ts";

const LINES = { staffLine: "- {staff}", customLine: "Appeal at discord.gg/lynx" };

/*
 * The two halves are independent by design: "signed by the admin" and "here is our Discord" are
 * separate decisions, and a community may want either, both or neither on any given action.
 */
test("each signature half applies on its own, together, or not at all", () => {
  const body = "Team killing after a warning";
  const sign = (staff: boolean, custom: boolean) =>
    applySignature(body, { ...LINES, use: { staff, custom }, staffName: "Jane" });

  assert.equal(sign(false, false), body, "neither half leaves the text exactly as typed");
  assert.equal(sign(true, false), "Team killing after a warning\n- Jane");
  assert.equal(sign(false, true), "Team killing after a warning\nAppeal at discord.gg/lynx");
  assert.equal(sign(true, true), "Team killing after a warning\n- Jane\nAppeal at discord.gg/lynx");
});

/*
 * Every one of these is a way to produce visible nonsense in front of a player, which is the one
 * audience that cannot ask what happened.
 */
test("a signature never produces dangling punctuation, a lone line, or a blank gap", () => {
  // Nothing to sign: a message that is only a postscript is a message nobody meant to send.
  assert.equal(applySignature("", { ...LINES, use: { staff: true, custom: true }, staffName: "Jane" }), "");
  assert.equal(applySignature("   ", { ...LINES, use: { staff: true, custom: true }, staffName: "Jane" }), "");

  // Automation has no name, so "- " must not dangle on the end of a ban reason.
  assert.equal(
    applySignature("Aimbot", { ...LINES, use: { staff: true, custom: false }, staffName: null }),
    "Aimbot",
  );

  // A half switched on but left blank contributes nothing rather than a trailing separator.
  assert.equal(
    applySignature("Aimbot", { staffLine: "  ", customLine: "", use: { staff: true, custom: true }, staffName: "Jane" }),
    "Aimbot",
  );

  // Every occurrence of the token is filled, not just the first.
  assert.equal(
    applySignature("x", { staffLine: "{staff} ({staff})", customLine: "", use: { staff: true, custom: false }, staffName: "Jane" }),
    "x\nJane (Jane)",
  );

  // A caller with a one-line surface can join differently without a second implementation.
  assert.equal(
    applySignature("x", { ...LINES, use: { staff: true, custom: false }, staffName: "Jane", separator: " " }),
    "x - Jane",
  );
});

/*
 * The app acting is not a person acting. Hard-coded here rather than left to each caller, because
 * three callers each remembering to pass staffName: null is three chances to forget.
 */
test("an automated action can only ever carry the second line", () => {
  const cfg = { ...LINES, actions: parseSignatureActions({ kick: { staff: true, custom: true } }) };
  assert.equal(automatedSignerFrom(cfg, "kick")("Idle"), "Idle\nAppeal at discord.gg/lynx");
  // An action nobody configured is left alone, and the signer short-circuits rather than rebuilding
  // the same string.
  assert.equal(automatedSignerFrom(cfg, "punish")("Idle"), "Idle");
});

test("an unconfigured or unknown action wants neither half, and junk cannot round-trip", () => {
  assert.deepEqual(signatureUseFor(undefined, "kick"), { staff: false, custom: false });
  assert.deepEqual(signatureUseFor({}, "kick"), { staff: false, custom: false });
  // "switch" shows the player nothing, so it is not signable and must not survive being posted.
  const parsed = parseSignatureActions({ kick: { staff: true, custom: false }, switch: { staff: true }, junk: 1 });
  assert.deepEqual(Object.keys(parsed), ["kick"]);
  assert.deepEqual(parsed.kick, { staff: true, custom: false });
  // Truthy-but-not-true values are coerced, so a "1" from a form cannot mean something different
  // from a true out of the store.
  assert.deepEqual(parseSignatureActions({ kick: { staff: "yes", custom: 1 } }).kick, { staff: false, custom: false });
});

test("every signable action has a label, so no surface has to invent one", () => {
  for (const a of SIGNABLE_ACTIONS) assert.ok(SIGNABLE_ACTION_LABELS[a], `${a} is named`);
});

/*
 * {player} and {staff} look alike and mean different names, which is exactly why the camera token
 * was renamed. The old spelling still resolves, because a message somebody already typed rendering
 * a literal "{admin}" to everyone on the server is a worse outcome than honouring an old name.
 */
test("the camera token fills the in-game name, and the retired spelling still resolves", () => {
  assert.equal(fillPlayerToken("An admin is watching. {player}", "Vet"), "An admin is watching. Vet");
  assert.equal(fillPlayerToken("An admin is watching. {admin}", "Vet"), "An admin is watching. Vet");
  // Both in one message, and more than once each — a naive replace would leave the second copy.
  assert.equal(fillPlayerToken("{player} / {admin} / {player}", "Vet"), "Vet / Vet / Vet");
  // A message with no token at all is left alone but still tidied, so a stray newline in the
  // config does not reach the game.
  assert.equal(fillPlayerToken("  An admin is watching.  ", "Vet"), "An admin is watching.");
  assert.equal(fillPlayerToken("   ", "Vet"), "", "a blank message stays blank, so the caller can skip it");
});
