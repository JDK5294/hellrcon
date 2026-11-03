// The answers that come from whatever stands in front of the panel's API (lib/gateway): said as
// what they are, never as a bare status that reads like a fault in the panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyAnswer } from "../lib/gateway.ts";

test("a proxy's own error says what happened and what to do", () => {
  assert.match(proxyAnswer(502), /did not answer \(HTTP 502 came from the proxy in front of it\)/);
  assert.match(proxyAnswer(504), /\(HTTP 504 came from the proxy in front of it\)/);
  // Cloudflare's error 1033, the tunnel to this computer down: what a phone sees while the
  // computer restarts for an update.
  assert.match(proxyAnswer(530), /^Cloudflare can't reach the computer the panel runs on \(HTTP 530\)\. It may be restarting/);
});

test("any other status is the API's own to explain", () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) assert.equal(proxyAnswer(status), null, `HTTP ${status}`);
});
