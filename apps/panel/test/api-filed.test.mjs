// The one client behaviour every screen depends on without knowing it: a write that was FILED
// instead of done must never come back looking like success.
//
// The decision and the words are tested here, at the leaf; `lib/api` does two lines with them
// (announce, then raise) so that every screen's existing "your write did not go through" path
// carries the news, without a hundred call sites learning what an approval is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDED_TO_REQUEST, SENT_FOR_APPROVAL, announceFiled, filedMessage, isFiled, onRequestFiled } from "../lib/filed.ts";

test("a 202 filing is recognised, and says which of the two things happened", () => {
  const filed = { requested: true, requestId: "r1", label: "Skip the map vote" };
  assert.equal(isFiled(202, filed), true);
  const msg = filedMessage(filed);
  assert.ok(msg.startsWith(SENT_FOR_APPROVAL), msg);
  assert.match(msg, /Skip the map vote/, "the action's own words, never the URL");
  assert.match(msg, /Moderation → Requests/, "and where to watch for the answer");

  const captured = { captured: true, lines: 3, label: "Pause or resume the map vote" };
  assert.ok(filedMessage(captured).startsWith(ADDED_TO_REQUEST));
  assert.match(filedMessage(captured), /review and submit/);

  // An action with no label still reads as a sentence rather than a dangling dash.
  assert.equal(filedMessage({ requested: true }).startsWith(`${SENT_FOR_APPROVAL} —`), true);
});

test("nothing else is mistaken for a filing", () => {
  assert.equal(isFiled(200, { requested: true }), false, "only a 202 is a filing");
  assert.equal(isFiled(202, { accepted: true }), false, "other 202s are somebody else's business");
  assert.equal(isFiled(202, null), false);
  assert.equal(isFiled(202, "nope"), false);
});

test("a capture is announced, so the request bar's count follows it", () => {
  const seen = [];
  const off = onRequestFiled((n) => seen.push(n));
  announceFiled({ captured: true, lines: 4 });
  assert.deepEqual(seen.map((n) => n.lines), [4]);
  off();
  announceFiled({ captured: true, lines: 5 });
  assert.equal(seen.length, 1, "unsubscribing means unsubscribed");
});
