/**
 * Typed text in a Discord message shows as written: Discord's formatting characters are escaped,
 * and a web address stays whole so it still opens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { discordLiteral } from "../src/discord-text.ts";

test("formatting characters are shown, not obeyed", () => {
  assert.equal(discordLiteral("*KLM* Smith"), "\\*KLM\\* Smith");
  assert.equal(discordLiteral("x_y `tank` ~~a~~ ||b||"), "x\\_y \\`tank\\` \\~\\~a\\~\\~ \\|\\|b\\|\\|");
  assert.equal(discordLiteral("back\\slash"), "back\\\\slash");
  assert.equal(discordLiteral("plain words"), "plain words");
});

test("a disguised link is shown as typed, its address whole", () => {
  assert.equal(discordLiteral("[free VIP](https://phish.example/a_b)"), "\\[free VIP\\](https://phish.example/a_b)");
  assert.equal(discordLiteral("see https://x.example/*y* and *z*"), "see https://x.example/*y* and \\*z\\*");
});
