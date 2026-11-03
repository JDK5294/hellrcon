import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import { loadApiConfig, PLACEHOLDER_SESSION_SECRETS } from "../dist/config.js";
import { resolveSessionSecret, SESSION_SECRET_KEY } from "../dist/session-secret.js";

/*
 * The templates shipped SESSION_SECRET with a placeholder value, and the app accepted it: every
 * install that never changed it signed logins with a key anybody could read in this repository.
 * A placeholder is now "not set", and the install keeps a key of its own — made once, then the same
 * on every boot, so logins survive restarts without anyone having to invent one.
 */
test("a placeholder or empty SESSION_SECRET is not a key: the install makes its own and signs with it on every boot", async () => {
  for (const placeholder of PLACEHOLDER_SESSION_SECRETS) {
    const cfg = loadApiConfig({ SESSION_SECRET: placeholder } as NodeJS.ProcessEnv);
    assert.equal(cfg.sessionSecretFromEnv, false, `${placeholder} is public`);
    assert.notEqual(cfg.sessionSecret, placeholder);
  }
  assert.equal(loadApiConfig({} as NodeJS.ProcessEnv).sessionSecretFromEnv, false, "unset is unset");
  assert.equal(loadApiConfig({ SESSION_SECRET: "   " } as NodeJS.ProcessEnv).sessionSecretFromEnv, false, "blank is unset");

  const repo = new InMemoryRepository();
  const boot1 = loadApiConfig({ SESSION_SECRET: "change-me-to-a-long-random-string" } as NodeJS.ProcessEnv);
  assert.equal(await resolveSessionSecret(repo, boot1), "stored");
  const kept = await repo.installSettings.get(SESSION_SECRET_KEY);
  assert.match(kept ?? "", /^[0-9a-f]{64}$/, "a random 256-bit key");
  assert.equal(boot1.sessionSecret, kept, "the first boot signs with the key it stored");
  const boot2 = loadApiConfig({} as NodeJS.ProcessEnv);
  await resolveSessionSecret(repo, boot2);
  assert.equal(boot2.sessionSecret, kept, "the next boot signs with the same one: logins survive restarts");
});

test("a SESSION_SECRET of its own still wins, and nothing is stored in its place", async () => {
  const repo = new InMemoryRepository();
  const cfg = loadApiConfig({ SESSION_SECRET: "a-real-secret-of-our-own" } as NodeJS.ProcessEnv);
  assert.equal(cfg.sessionSecretFromEnv, true);
  assert.equal(await resolveSessionSecret(repo, cfg), "env");
  assert.equal(cfg.sessionSecret, "a-real-secret-of-our-own");
  assert.equal(await repo.installSettings.get(SESSION_SECRET_KEY), null);
});
