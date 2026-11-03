/**
 * The live welcome message writes to the game only when it must — the answer to "won't mass joins
 * spam the server?": joins are not an input at all; only a changed text (or a very old write) is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { welcomeNeedsWrite, WELCOME_REASSERT_MS } from "../dist/welcome.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("an unchanged text is never rewritten, however often it is checked", () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(welcomeNeedsWrite({ filled: "Next: Foy", lastText: "Next: Foy", lastWrittenAt: ago(60_000 * i), nowMs: NOW }), false);
  }
});

test("a changed text is written; so is the first one", () => {
  assert.equal(welcomeNeedsWrite({ filled: "Next: Hill 400", lastText: "Next: Foy", lastWrittenAt: ago(1000), nowMs: NOW }), true);
  assert.equal(welcomeNeedsWrite({ filled: "Next: Foy", lastText: null, lastWrittenAt: null, nowMs: NOW }), true);
});

test("a very old write is re-asserted once, in case the game dropped it", () => {
  assert.equal(welcomeNeedsWrite({ filled: "x", lastText: "x", lastWrittenAt: ago(WELCOME_REASSERT_MS - 1000), nowMs: NOW }), false);
  assert.equal(welcomeNeedsWrite({ filled: "x", lastText: "x", lastWrittenAt: ago(WELCOME_REASSERT_MS), nowMs: NOW }), true);
});
