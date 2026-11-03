/**
 * @app/db — entities, the Repository interface, and implementations.
 *
 * - In-memory repo: dev, tests, and a zero-setup demo.
 * - Postgres repo: production persistence (migrations in migrations.ts).
 *
 * Callers depend only on the Repository interface, so switching stores changes nothing.
 */
export * from "./types.js";
export { InMemoryRepository } from "./memory.js";
export { PostgresRepository, createPostgresRepository } from "./postgres.js";
export { MIGRATIONS } from "./migrations.js";
export { MESSAGE_PLACEHOLDERS, SERVER_QUALIFIED_PLACEHOLDERS, hasPlaceholders, playerPlaceholdersIn, serverWideTextError, messageRenderer, playtimeSpan, vipSpan, formatVipUntil, serverTimezone, type LiveFacts, type MessageRenderer, type RendererTarget } from "./placeholders.js";
export { gameBanRanOut, planBanReconcile, reconcileSignature, type BanReconcilePlan, type GameBanLite } from "./ban-reconcile.js";
export { FEATURES, APP_SETTINGS, FEATURE_PRESETS, getAppSetting, getFeaturePreset, isAppSettingKey, presetGameMismatch, type AppSettingDef, type FeatureDef, type FeaturePresetDef } from "./features.js";
export { composeSeedingAnnounce, seedActionSummary, seedingRestrictions, RESTRICTED_SEED_RULES, type SeedActionReason, type SeedingLabels, type SeedRule } from "./seeding-message.js";
export type { Migration } from "./migrations.js";
export { createIsolatedRepository, type IsolatedRepository } from "./isolated.js";
export { bankIfHeld, rewardsRefusedBy } from "./vip-holds.js";
export { INSTALL_ENV_SETTINGS, applyInstallEnv, importInstallEnv, installEnvSetting, type InstallEnvSetting } from "./install-env.js";
export {
  CLAN_CURRENT_GRACE_SEC, CLAN_LABEL_MAX, CLAN_MERGES_MAX, CLAN_TAG_SETTINGS_DEFAULTS,
  clanCombineTarget, clanFoldKey, clanGroupCustomised, clanGroupName, clanGroupOf, clanLabel, clanResolveKey, combineClanGroups, groupClanSpellings,
  normalizeClanTagSettings, renameClanGroup, resetClanGroup, splitClanSpelling, type ClanTagSettings,
} from "./clan-tags.js";

import { InMemoryRepository } from "./memory.js";
import { createPostgresRepository } from "./postgres.js";
import type { Repository } from "./types.js";

/**
 * Choose a repository from the environment: Postgres when DATABASE_URL is set (and
 * migrations run), otherwise the in-memory repo. Async because Postgres runs migrations.
 */
export async function createRepository(env: NodeJS.ProcessEnv = process.env): Promise<Repository> {
  const url = env.DATABASE_URL;
  if (url) {
    const repo = await createPostgresRepository(url);
    return repo;
  }
  return new InMemoryRepository();
}
