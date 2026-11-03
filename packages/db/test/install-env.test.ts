// The Discord app's credentials and the stats site, set in the panel: what every process reads
// from its environment, and how an install configured in infra/.env carries over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInstallEnv, importInstallEnv, InMemoryRepository, INSTALL_ENV_SETTINGS, type Repository } from "../dist/index.js";

/** The settings store as every caller sees it — the interface, options and all. */
const store = (): Pick<Repository, "installSettings"> => new InMemoryRepository();

test("an install that set them in infra/.env carries them over once; the panel's values win from then on", async () => {
  const repo = store();
  const env: NodeJS.ProcessEnv = { DISCORD_TOKEN: "from.env.file", DISCORD_GUILD_ID: " 123456789012345678 ", PUBLIC_STATS_NAME: "" };
  assert.deepEqual(await importInstallEnv(repo, env), ["DISCORD_TOKEN", "DISCORD_GUILD_ID"], "what infra/.env sets, and nothing it leaves blank");
  assert.equal(await repo.installSettings.get("discord.token"), "from.env.file");
  assert.equal(await repo.installSettings.get("discord.guildId"), "123456789012345678", "trimmed");
  assert.equal(await repo.installSettings.get("stats.name"), null);

  await repo.installSettings.set("discord.token", "from.the.panel", { secret: true });
  assert.deepEqual(await importInstallEnv(repo, env), [], "once: the next boot carries nothing over the panel's value");
  assert.deepEqual(await applyInstallEnv(repo, env), ["DISCORD_TOKEN", "DISCORD_GUILD_ID"]);
  assert.equal(env.DISCORD_TOKEN, "from.the.panel", "the panel's value is the one in force");
  assert.equal(env.DISCORD_GUILD_ID, "123456789012345678");
  assert.deepEqual(await applyInstallEnv(repo, env), [], "nothing changes when nothing changed");
});

test("a value cleared in the panel stays cleared — the old .env line is not carried over again", async () => {
  const repo = store();
  const env: NodeJS.ProcessEnv = { DISCORD_CLIENT_SECRET: "old-secret" };
  await importInstallEnv(repo, env);
  await repo.installSettings.set("discord.clientSecret", "", { secret: true });
  assert.deepEqual(await applyInstallEnv(repo, env), ["DISCORD_CLIENT_SECRET"]);
  assert.equal("DISCORD_CLIENT_SECRET" in env, false, "unset, so every reader sees it missing");
  assert.deepEqual(await importInstallEnv(repo, { DISCORD_CLIENT_SECRET: "old-secret" }), [], "and a restart does not bring it back");
});

test("a key the panel never set leaves the environment's own value alone", async () => {
  const repo = store();
  const env: NodeJS.ProcessEnv = { DISCORD_APP_ID: "999" };
  assert.deepEqual(await applyInstallEnv(repo, env), []);
  assert.equal(env.DISCORD_APP_ID, "999");
});

test("carried-over tokens and secrets are stored sealed, the ids are not", async () => {
  const stored: { key: string; secret?: boolean }[] = [];
  const repo = { installSettings: {
    get: async () => null,
    set: async (key: string, _value: string | null, opts?: { secret?: boolean }) => { stored.push({ key, secret: opts?.secret }); },
    getOrCreate: async () => "",
  } };
  await importInstallEnv(repo, { DISCORD_TOKEN: "t", DISCORD_CLIENT_SECRET: "s", DISCORD_APP_ID: "1" });
  assert.deepEqual(stored, [{ key: "discord.token", secret: true }, { key: "discord.appId", secret: false }, { key: "discord.clientSecret", secret: true }]);
  assert.deepEqual(INSTALL_ENV_SETTINGS.filter((s) => s.secret).map((s) => s.env), ["DISCORD_TOKEN", "DISCORD_CLIENT_SECRET", "CLOUDFLARE_TUNNEL_TOKEN"]);
});
