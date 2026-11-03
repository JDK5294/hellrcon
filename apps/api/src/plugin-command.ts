/**
 * Runs one of a plugin's host commands — for what must never be done from the panel, such as
 * clearing a forgotten password that guards a plugin's own screen. Run on the host:
 *
 *   docker compose --env-file infra\.env -f infra\docker-compose.yml exec api node apps/api/dist/plugin-command.js <plugin id> <command>
 *
 * It loads the plugins the way the API does, against the same database, and runs the one command,
 * printing what it returns. Named without a command, it lists the plugin's commands. Whoever can
 * run this already holds the database and the key, so it opens nothing new.
 */
import { createRepository } from "@app/db";
import { buildPluginRuntime } from "./plugin-host.js";

async function main(): Promise<void> {
  const [pluginId, name] = process.argv.slice(2);
  if (!pluginId) {
    console.error("Usage: node apps/api/dist/plugin-command.js <plugin id> [command]");
    process.exit(2);
  }
  // Without a database this would run against a throwaway in-memory store and claim success.
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run this inside the api container, where it is.");
    process.exit(1);
  }
  const repo = await createRepository();
  const runtime = await buildPluginRuntime(repo);
  if (!runtime.host.list().some((m) => m.id === pluginId)) {
    console.error(`No plugin "${pluginId}" is loaded. Is it in the installed-plugins folder?`);
    process.exit(1);
  }
  const listing = runtime.commands.list(pluginId).map((c) => `  ${c.name}  ${c.description}`).join("\n");
  if (!name) {
    console.log(listing ? `Commands of ${pluginId}:\n${listing}` : `Plugin ${pluginId} has no commands.`);
    process.exit(0);
  }
  const command = runtime.commands.get(pluginId, name);
  if (!command) {
    console.error(`Plugin ${pluginId} has no command "${name}".${listing ? `\nIts commands:\n${listing}` : ""}`);
    process.exit(1);
  }
  console.log(await command.run());
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
