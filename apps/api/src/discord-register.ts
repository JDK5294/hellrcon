/**
 * One-shot: register the bot's slash command with Discord. The panel's Discord hub has a
 * "Register command" button that does exactly this, and that is the normal way — this CLI stays
 * for deploys with no panel session yet (`pnpm --filter @app/api discord:register`).
 *
 * Needs DISCORD_TOKEN + DISCORD_APP_ID. The install is global — every guild the bot is in — and
 * who may actually open the panel is the staff guild's role map, checked at press time. The
 * command NAME comes from the database, not from here, so this and the button install the same
 * thing.
 */
import { createRepository } from "@app/db";
import { registerCommands } from "./discord.js";

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  if (!token || !appId) {
    console.error("Set DISCORD_TOKEN and DISCORD_APP_ID (and optionally DISCORD_GUILD_ID).");
    process.exit(1);
  }
  const repo = await createRepository();
  // Global — every guild the bot is in. These ids are only a floor for the guild-scoped sweep:
  // registerCommands asks Discord for the real guild list, because an old per-server command
  // outranks the global one and survives in any guild nobody wrote an id down for.
  const { communityGuildId } = await repo.appConfig.get();
  const stale = [...new Set([process.env.DISCORD_GUILD_ID || "", communityGuildId].filter(Boolean))];
  const cfg = await repo.discordCommands.get();
  const { names, clearedGuilds } = await registerCommands(token, appId, cfg, stale);
  const where = "globally (every server the bot is in)";
  console.log(names.length
    ? `Registered /${names[0]} ${where}.`
    : `The command is switched off — cleared all commands ${where}.`);
  console.log(`Cleared older per-server copies in ${clearedGuilds.length} server(s).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
