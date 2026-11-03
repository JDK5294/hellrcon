import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { LoginThrottle, clientAddrOf } from "../dist/rate-limit.js";

/** A throttle on a hand-cranked clock, so windows expire when the test says so. */
function throttled(startMs = 0) {
  let t = startMs;
  const th = new LoginThrottle(() => t);
  return { th, tick: (ms: number) => { t += ms; } };
}

test("five failures lock a username; the sixth attempt is refused before any work", () => {
  const { th } = throttled();
  for (let i = 0; i < 5; i++) {
    assert.equal(th.check("admin", "1.2.3.4").allowed, true, `attempt ${i + 1} may proceed`);
    th.fail("admin", "1.2.3.4");
  }
  const gate = th.check("admin", "1.2.3.4");
  assert.equal(gate.allowed, false);
  assert.ok(gate.retryAfterSec > 0 && gate.retryAfterSec <= 15 * 60, "retry-after is inside the window");
});

test("the username budget follows the account, not the address", () => {
  // The point of the per-name window: a botnet rotating addresses still locks the account.
  const { th } = throttled();
  for (let i = 0; i < 5; i++) th.fail("admin", `10.0.0.${i}`);
  assert.equal(th.check("admin", "10.0.0.99").allowed, false, "a fresh address does not reset the account");
});

test("usernames are case-folded the way login matches them", () => {
  const { th } = throttled();
  for (let i = 0; i < 5; i++) th.fail("Admin", "1.2.3.4");
  assert.equal(th.check("admin", "5.6.7.8").allowed, false, "ADMIN and admin are one budget");
});

test("failures age out of the window", () => {
  const { th, tick } = throttled();
  for (let i = 0; i < 5; i++) th.fail("admin", "1.2.3.4");
  assert.equal(th.check("admin", "1.2.3.4").allowed, false);
  tick(15 * 60_000 + 1);
  assert.equal(th.check("admin", "1.2.3.4").allowed, true, "the window has passed");
});

test("a successful login clears the username, not the address", () => {
  const { th } = throttled();
  // The address accumulates failures across many usernames…
  for (let i = 0; i < 30; i++) th.fail(`user${i}`, "6.6.6.6");
  // …then one guess lands. The account's slate is clean; the address's budget is spent.
  th.succeed("user3");
  assert.equal(th.check("user3", "6.6.6.6").allowed, false, "success never refunds the spraying address");
  assert.equal(th.check("user3", "9.9.9.9").allowed, true, "the account itself is clear from elsewhere");
});

test("one address spraying many usernames hits the address net", () => {
  const { th } = throttled();
  for (let i = 0; i < 30; i++) th.fail(`guess${i}`, "6.6.6.6");
  assert.equal(th.check("somebody-new", "6.6.6.6").allowed, false, "31st username from one address is refused");
  assert.equal(th.check("somebody-new", "7.7.7.7").allowed, true, "other addresses are unaffected");
});

test("the login route enforces the throttle end to end", async () => {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (username: string, password: string) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  try {
    await fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-horse" }),
    });

    // A username that does not even exist still burns its budget — existence must not be
    // learnable by comparing when the throttle kicks in.
    for (let i = 0; i < 5; i++) assert.equal((await login("nosuchuser", "guess")).status, 401);
    assert.equal((await login("nosuchuser", "guess")).status, 429, "unknown accounts throttle identically");

    // The lock is per account: those failures do not touch admin, who signs in fine…
    assert.equal((await login("admin", "correct-horse")).status, 200);

    // …until admin earns their own five. Then even the RIGHT password answers 429, which is the
    // lockout doing its one job, with a retry-after saying when to come back.
    for (let i = 0; i < 5; i++) assert.equal((await login("admin", "wrong")).status, 401);
    const locked = await login("admin", "correct-horse");
    assert.equal(locked.status, 429, "the lock holds even for the real password");
    assert.ok(Number(locked.headers.get("retry-after")) > 0, "429 carries retry-after");
  } finally {
    server.close();
  }
});

test("clientAddrOf prefers cf-connecting-ip, then the first x-forwarded-for hop, then the socket", () => {
  assert.equal(clientAddrOf({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" }, "127.0.0.1"), "203.0.113.9");
  assert.equal(clientAddrOf({ "x-forwarded-for": "203.0.113.9, 172.16.0.1, 127.0.0.1" }, "127.0.0.1"), "203.0.113.9");
  assert.equal(clientAddrOf({}, "192.168.1.50"), "192.168.1.50");
  assert.equal(clientAddrOf({}, undefined), "unknown");
});
