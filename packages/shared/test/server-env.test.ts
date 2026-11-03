import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerEnv } from "../src/server-env.ts";

test("parses a complete SERVER_n_* entry", () => {
  const entries = parseServerEnv({
    SERVER_1_HOST: "1.2.3.4",
    SERVER_1_PORT: "28865",
    SERVER_1_PASSWORD: "secret",
    SERVER_1_HEADER_MODE: "legacy",
    SERVER_1_NAME: "My Server",
    SERVER_1_GAME: "hllv",
    SERVER_1_PROTOCOL: "binary-v2",
  } as NodeJS.ProcessEnv);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    index: 1, name: "My Server", host: "1.2.3.4", port: 28865, password: "secret", headerMode: "legacy",
    game: "hllv", protocol: "binary-v2", crconBaseUrl: undefined,
  });
});

test("defaults header mode to magic and name to undefined", () => {
  const [e] = parseServerEnv({ SERVER_2_HOST: "h", SERVER_2_PORT: "1", SERVER_2_PASSWORD: "p" } as NodeJS.ProcessEnv);
  assert.equal(e!.headerMode, "magic");
  assert.equal(e!.name, undefined);
});

// The game is carried, not resolved: this package has no game registry, and validating in two
// places is how the seeded game and the panel's idea of it drift apart.
test("game and protocol are carried as lower-cased strings, unset when absent", () => {
  const [loud] = parseServerEnv({
    SERVER_1_HOST: "h", SERVER_1_PORT: "1", SERVER_1_PASSWORD: "p",
    SERVER_1_GAME: "  HLLV  ", SERVER_1_PROTOCOL: "Legacy-Text",
  } as NodeJS.ProcessEnv);
  assert.equal(loud!.game, "hllv", "trimmed and lower-cased so casing in .env never matters");
  assert.equal(loud!.protocol, "legacy-text");

  const [bare] = parseServerEnv({ SERVER_1_HOST: "h", SERVER_1_PORT: "1", SERVER_1_PASSWORD: "p" } as NodeJS.ProcessEnv);
  assert.equal(bare!.game, undefined, "absent, not defaulted here — the caller decides and logs it");
  assert.equal(bare!.protocol, undefined);
});

test("an empty game/protocol reads as unset rather than as the empty string", () => {
  // `SERVER_1_GAME=` in a .env file is a blank value, and "" is not a game id — treating it as one
  // would refuse the whole entry over a stray line.
  const [e] = parseServerEnv({
    SERVER_1_HOST: "h", SERVER_1_PORT: "1", SERVER_1_PASSWORD: "p", SERVER_1_GAME: "   ", SERVER_1_PROTOCOL: "",
  } as NodeJS.ProcessEnv);
  assert.equal(e!.game, undefined);
  assert.equal(e!.protocol, undefined);
});

test("carries the CRCON base URL for crcon-bridge servers", () => {
  const [e] = parseServerEnv({
    SERVER_1_HOST: "h", SERVER_1_PORT: "1", SERVER_1_PASSWORD: "key",
    SERVER_1_PROTOCOL: "crcon-bridge", SERVER_1_CRCON_URL: "https://crcon.example.com ",
  } as NodeJS.ProcessEnv);
  assert.equal(e!.crconBaseUrl, "https://crcon.example.com");
});

test("skips incomplete entries (missing password/port/host)", () => {
  const entries = parseServerEnv({
    SERVER_1_HOST: "h",
    SERVER_1_PORT: "1",
    // no password -> skipped
    SERVER_3_HOST: "h3",
    SERVER_3_PASSWORD: "p3",
    // no port -> skipped
  } as NodeJS.ProcessEnv);
  assert.equal(entries.length, 0);
});

test("discovers non-contiguous indices in order", () => {
  const entries = parseServerEnv({
    SERVER_5_HOST: "e", SERVER_5_PORT: "5", SERVER_5_PASSWORD: "p",
    SERVER_2_HOST: "b", SERVER_2_PORT: "2", SERVER_2_PASSWORD: "p",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(entries.map((e) => e.index), [2, 5]);
});

test("ignores unrelated env vars", () => {
  const entries = parseServerEnv({ SESSION_SECRET: "x", DATABASE_URL: "y", API_PORT: "8080" } as NodeJS.ProcessEnv);
  assert.equal(entries.length, 0);
});
