import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDiscordAuthConfigured, signState, verifyState, buildAuthorizeUrl, memberRoleIds, discordAuthConfig,
  oauthStateCookie, readStateCookie, OAUTH_STATE_COOKIE,
  linkStateNonce, parseLinkNonce, discordGet, isDiscordTransient,
} from "../src/discord-auth.ts";

const cfg = { clientId: "cid", clientSecret: "secret", guildId: "guild1", redirectUri: "https://panel.example/api/auth/discord/callback" };

test("isDiscordAuthConfigured: all four pieces required", () => {
  assert.equal(isDiscordAuthConfigured(cfg), true);
  assert.equal(isDiscordAuthConfigured({ ...cfg, clientSecret: "" }), false);
  assert.equal(isDiscordAuthConfigured({ ...cfg, guildId: "" }), false);
});

test("discordAuthConfig: reads env", () => {
  const c = discordAuthConfig({ DISCORD_CLIENT_ID: "a", DISCORD_CLIENT_SECRET: "b", DISCORD_GUILD_ID: "g", DISCORD_OAUTH_REDIRECT: "r" } as NodeJS.ProcessEnv);
  assert.deepEqual(c, { clientId: "a", clientSecret: "b", guildId: "g", redirectUri: "r" });
});

test("state: round-trips, rejects tamper + expiry", () => {
  const s = signState("sekret", "nonce-abc");
  assert.equal(verifyState("sekret", s), "nonce-abc");
  assert.equal(verifyState("wrong", s), null);          // bad secret
  assert.equal(verifyState("sekret", s + "x"), null);   // tampered sig
  assert.equal(verifyState("sekret", "a.b"), null);     // wrong shape
  // expired: signed 20 min ago with a 10 min ttl
  const past = Date.now() - 20 * 60_000;
  const old = signState("sekret", "n", 600, past);
  assert.equal(verifyState("sekret", old), null);
});

test("buildAuthorizeUrl: carries client id, redirect, scopes, state", () => {
  const url = new URL(buildAuthorizeUrl(cfg, "STATE123"));
  assert.equal(url.origin + url.pathname, "https://discord.com/api/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), cfg.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "STATE123");
  assert.match(url.searchParams.get("scope") ?? "", /guilds\.members\.read/);
});

test("memberRoleIds: pulls the roles array defensively", () => {
  assert.deepEqual(memberRoleIds({ roles: ["a", "b", 3] }), ["a", "b"]);
  assert.deepEqual(memberRoleIds(null), []);
  assert.deepEqual(memberRoleIds({}), []);
});

test("link-state nonce: round-trips the user id, and ordinary nonces are not link requests", () => {
  const nonce = linkStateNonce("11111111-2222-3333-4444-555555555555", "rand-om");
  assert.equal(parseLinkNonce(nonce), "11111111-2222-3333-4444-555555555555");
  // Signed and verified like any other state — the payload survives the trip.
  const state = signState("secret", nonce);
  assert.equal(parseLinkNonce(verifyState("secret", state)!), "11111111-2222-3333-4444-555555555555");
  assert.equal(parseLinkNonce("just-a-random-nonce"), null);
  assert.equal(parseLinkNonce("link:missing-random"), null); // malformed: no separator after the id
});

/*
 * The half of CSRF protection a signed state does not provide.
 *
 * `state` proves the value came from us and has not expired. It does not prove WHICH browser is
 * finishing the flow, because anyone can obtain one by loading /start — so on its own it does not
 * stop an attacker holding their own unspent code+state and getting a staff member to open that
 * callback URL. The panel consumes `#discord_token` on load with no interaction, so the victim
 * ends up silently signed in as the attacker, with their actions recorded against that account.
 */
test("the state cookie is scoped, hidden from scripts, and sent on the callback navigation", () => {
  const c = oauthStateCookie("nonce-abc", "https://panel.example/api/auth/discord/callback");
  assert.match(c, new RegExp(`^${OAUTH_STATE_COOKIE}=nonce-abc;`));
  assert.match(c, /HttpOnly/, "a script must not be able to read it");
  // Lax, not Strict: the callback is a top-level GET navigation from discord.com. Strict would
  // withhold the cookie there and break every sign-in.
  assert.match(c, /SameSite=Lax/);
  assert.ok(!/SameSite=Strict/.test(c), "Strict would block the callback navigation itself");
  assert.match(c, /Path=\/api\/auth\/discord/, "sent on the OAuth routes and nowhere else");
  assert.match(c, /Max-Age=600/);
  assert.match(c, /Secure/);
});

test("Secure follows the redirect scheme, so a plain-http install can still sign in", () => {
  // Hardcoding Secure would mean the cookie is silently never stored on an http LAN deployment,
  // and "sign-in stopped working" is a worse outcome than the flag it was protecting.
  assert.ok(!/Secure/.test(oauthStateCookie("n", "http://192.168.1.10:8080/api/auth/discord/callback")));
  assert.match(oauthStateCookie("n", "https://panel.example/cb"), /Secure/);
});

test("clearing the cookie expires it rather than leaving a value behind", () => {
  const cleared = oauthStateCookie(null, "https://panel.example/cb");
  assert.match(cleared, new RegExp(`^${OAUTH_STATE_COOKIE}=;`));
  assert.match(cleared, /Max-Age=0/);
});

test("reading the cookie ignores everything else in the header", () => {
  assert.equal(readStateCookie(`other=1; ${OAUTH_STATE_COOKIE}=abc; third=2`), "abc");
  assert.equal(readStateCookie(`${OAUTH_STATE_COOKIE}=abc`), "abc");
  assert.equal(readStateCookie(`  ${OAUTH_STATE_COOKIE}  =  abc  `), "abc", "whitespace around either side");
  // A nonce is url-encoded going in, so it must come back decoded or it can never match the state.
  assert.equal(readStateCookie(`${OAUTH_STATE_COOKIE}=${encodeURIComponent("link:u1:r2")}`), "link:u1:r2");
  // Nothing usable reads as "no cookie", never as a value that might accidentally match.
  for (const header of [undefined, "", "junk", "other=1", `${OAUTH_STATE_COOKIE}=`, `${OAUTH_STATE_COOKIE}`]) {
    assert.equal(readStateCookie(header), null, `header ${JSON.stringify(header)} should read as absent`);
  }
  assert.equal(readStateCookie(`${OAUTH_STATE_COOKIE}=%E0%A4%A`), null, "a malformed encoding is not a nonce");
});

test("the cookie round-trips the nonce a state is signed with", () => {
  // The whole mechanism rests on these two agreeing, including for a link-mode nonce whose colons
  // would otherwise be at the mercy of cookie encoding.
  for (const nonce of ["plain-uuid-1234", "link:00000000-0000-0000-0000-000000000001:abc"]) {
    const header = oauthStateCookie(nonce, "https://p/cb").split(";")[0]!;
    assert.equal(readStateCookie(header), nonce);
    assert.equal(verifyState("sekret", signState("sekret", nonce)), readStateCookie(header),
      "the value in the cookie is the value the callback compares against");
  }
});

/*
 * Discord being busy is not a statement about the person signing in.
 *
 * The callback read ANY non-2xx from the guild-member endpoint as "you're not a member of this
 * Discord server" — so a 429 (that endpoint is rate-limited, and several staff signing in together
 * is enough) or one of Discord's 5xx minutes told a staff member their membership was the problem
 * and sent them to an admin over something that fixes itself. These pin the two halves: retry what
 * is transient, and classify what is left.
 */
test("discordGet: retries a rate limit and honours retry-after", async () => {
  const waits: number[] = [];
  const statuses = [429, 500, 200];
  let calls = 0;
  const res = await discordGet("https://discord.example/x", { authorization: "Bearer t" }, {
    fetchImpl: (async () => {
      const status = statuses[calls++]!;
      return new Response("{}", { status, headers: status === 429 ? { "retry-after": "1" } : {} });
    }) as unknown as typeof fetch,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(res.status, 200, "it keeps going until Discord actually answers");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 500], "retry-after in seconds is honoured; the fallback backs off");
});

test("discordGet: a real answer is returned immediately, and retries are bounded", async () => {
  let calls = 0;
  const once = await discordGet("https://discord.example/x", {}, {
    fetchImpl: (async () => { calls++; return new Response("{}", { status: 404 }); }) as unknown as typeof fetch,
    sleep: async () => {},
  });
  assert.equal(once.status, 404);
  assert.equal(calls, 1, "404 means Discord answered — retrying it would only slow the refusal down");

  calls = 0;
  const givenUp = await discordGet("https://discord.example/x", {}, {
    fetchImpl: (async () => { calls++; return new Response("{}", { status: 503 }); }) as unknown as typeof fetch,
    sleep: async () => {},
  });
  assert.equal(givenUp.status, 503, "a sustained outage still returns, so the caller can say so");
  assert.equal(calls, 3, "and it does not retry forever inside a redirect");
});

test("isDiscordTransient: separates 'Discord is busy' from 'Discord answered'", () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isDiscordTransient(s), true, `${s} is transient`);
  // 404 is the ONLY status that means "not in this guild"; 401/403 mean the app lost its scope.
  for (const s of [200, 401, 403, 404]) assert.equal(isDiscordTransient(s), false, `${s} is a real answer`);
});
