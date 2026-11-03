/**
 * Shared config loading & common types.
 *
 * Everything is read from the environment/config — no hardcoded hosts, ports, paths,
 * cloud services, or tenancy assumptions (see the deployment-agnostic requirement).
 */

/** The product's name. The panel keeps its own copy (apps/panel/lib/brand.ts). */
export const APP_NAME = "hellrcon";

/** Per-server engagement mode. `observe` is read-only and safe alongside an existing CRCON. */
export type EngagementMode = "observe" | "active";

/** RCON wire protocols supported via pluggable adapters in rcon-core. */
export type RconProtocol = "legacy-text" | "binary-v2" | "crcon-bridge";

/** RBAC grant scope. */
export type GrantScope = "global" | "server" | "group";

/** Access level for a capability within a scope. */
export type AccessLevel = "none" | "read" | "write";

export interface CoreConfig {
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
}

export * from "./errors.js";
export * from "./logger.js";
export * from "./server-env.js";
export * from "./crcon-archive.js";
export * from "./process-guards.js";
export * from "./background.js";
export * from "./signature.js";
export * from "./discord-rest.js";
export * from "./discord-members.js";
export * from "./discord-text.js";
export * from "./live-share.js";

/** Read core config from the environment. Throws if a required value is missing. */
export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const databaseUrl = env.DATABASE_URL;
  const redisUrl = env.REDIS_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!redisUrl) throw new Error("REDIS_URL is required");
  return {
    databaseUrl,
    redisUrl,
    apiPort: Number(env.API_PORT ?? env.PORT ?? 8080),
  };
}
export * from "./restore-marker.js";
