// The Discord form's "Use this panel's address": not offered where it would work for nobody else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCORD_CALLBACK_PATH, suggestedCallback } from "../lib/discordCallback.ts";

test("the return address is offered from the panel's own address, unless that is this computer's", () => {
  assert.equal(suggestedCallback({ hostname: "admin.example.com", origin: "https://admin.example.com" }), `https://admin.example.com${DISCORD_CALLBACK_PATH}`);
  assert.equal(suggestedCallback({ hostname: "192.168.1.20", origin: "http://192.168.1.20:8080" }), `http://192.168.1.20:8080${DISCORD_CALLBACK_PATH}`, "an address on the network, as before");
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(suggestedCallback({ hostname, origin: `http://${hostname}:8080` }), "", `${hostname}: this computer only`);
  }
});
