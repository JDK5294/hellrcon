/**
 * The install's settings that are set in the panel — the Discord app and the public stats site —
 * put in force in the API (the shared half, and why they are read from the environment, is
 * @app/db's install-env.ts).
 */
import { applyInstallEnv, importInstallEnv, type Repository } from "@app/db";
import { publicStatsConfig, type ApiConfig } from "./config.js";

type Settings = Pick<Repository, "installSettings">;

/** Boot: carry over what an older install kept in infra/.env (once), then put the stored values in
 *  force. Returns the variables carried over. */
export async function settleInstallEnv(repo: Settings, config: ApiConfig): Promise<string[]> {
  const carried = await importInstallEnv(repo);
  await refreshInstallEnv(repo, config);
  return carried;
}

/** After a save in the panel: this process's environment, and the stats site's config read from it. */
export async function refreshInstallEnv(repo: Settings, config: ApiConfig): Promise<void> {
  await applyInstallEnv(repo);
  Object.assign(config, publicStatsConfig());
}
