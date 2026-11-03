import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_CARD_MAX, DISCORD_MESSAGE_MAX, closedApprovalCard } from "../dist/index.js";

test("a card the expiry sweep closes always fits in one Discord message", () => {
  const short = closedApprovalCard("✋ **Approval request** from **Mod**\n⏳ **Kick** Bob", 1);
  assert.match(short, /^✋ \*\*Approval request\*\* from \*\*Mod\*\*\n⏳ \*\*Kick\*\* Bob\n⌛ \*\*Expired\*\* — nobody signed this in time, so its one pending line was voided\. It can be filed again\.$/);
  // At the card's own ceiling the closing line still fits…
  const atCeiling = closedApprovalCard("x".repeat(APPROVAL_CARD_MAX), 3);
  assert.ok(atCeiling.length <= DISCORD_MESSAGE_MAX, `${atCeiling.length} characters`);
  assert.ok(atCeiling.startsWith("x".repeat(APPROVAL_CARD_MAX)), "nothing of a card at its ceiling is lost");
  // …and text that would not fit is trimmed, never sent to be refused.
  const over = closedApprovalCard("y".repeat(DISCORD_MESSAGE_MAX), 2);
  assert.ok(over.length <= DISCORD_MESSAGE_MAX, `${over.length} characters`);
  assert.match(over, /…\n⌛ \*\*Expired\*\* — nobody signed this in time, so its 2 pending lines were voided\. It can be filed again\.$/);
  assert.match(closedApprovalCard("card", 0), /in time\. It can be filed again\.$/);
});
