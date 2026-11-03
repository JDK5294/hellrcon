/**
 * The key that signs logins, settled once the database is up.
 *
 * SESSION_SECRET in infra/.env still wins when it holds a value of its own. Otherwise — unset, or
 * one of the placeholders the templates shipped — the install keeps its own key: made on the first
 * boot, stored (sealed with ENCRYPTION_KEY when there is one) and the same on every boot after, so
 * nobody has to invent one and logins survive restarts. An install that ran on a placeholder signs
 * in afresh once after this, which is the point: that key was public.
 */
import { randomBytes } from "node:crypto";
import type { Repository } from "@app/db";
import type { ApiConfig } from "./config.js";

/** Where the key lives in the install's own settings. */
export const SESSION_SECRET_KEY = "session.secret";

export async function resolveSessionSecret(repo: Pick<Repository, "installSettings">, config: ApiConfig): Promise<"env" | "stored"> {
  if (config.sessionSecretFromEnv) return "env";
  config.sessionSecret = await repo.installSettings.getOrCreate(SESSION_SECRET_KEY, () => randomBytes(32).toString("hex"), { secret: true });
  return "stored";
}
