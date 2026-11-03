/**
 * Postgres-backed Repository (same interface as the in-memory one). Uses node-postgres.
 * Ids are generated in app code (randomUUID) for portability and testability.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { armRestoreMarker, clearRestoreMarker, createLogger } from "@app/shared";
import { sealSecret, openSecret, isSealed } from "@app/access";
import { parseSignatureActions } from "@app/shared";
import { MAPVOTE_STARTUP_STATES, PERMANENT_KV_PREFIX, MIN_MATCH_MS, storedVipExpiration, VIP_TIMELINE_ACTIONS, VIP_TIMELINE_EXPIRY_ACTIONS, ECONOMY_ACTIVITY_KINDS, economyActivityKind, EVENT_POST_DEFAULTS, ADMIN_CAM_DEFAULTS, SIGNATURE_DEFAULTS, ECONOMY_DEFAULTS, ECONOMY_LEDGER_PAGE, DISCORD_COMMAND_DEFAULTS, APP_CONFIG_DEFAULTS, CHAT_FILTER_DEFAULTS, TRIM_CATEGORIES, safeTimezone } from "./types.js";
import type { AccessLevel, EngagementMode, RconProtocol } from "@app/shared";
import type {
  AnalyticsWindow,
  AnnouncementNudgeConfig,
  AnnouncementPatch,
  AnnouncementReadRow,
  AnnouncementRow,
  ApiTokenRow,
  PushSubscriptionRow,
  AuditQuery,
  AuditRow,
  NewPlayerTrigger,
  PlayerTriggerRow,
  PlayerTriggerEdit,
  AutoSettingsConfigPatch,
  AutoSettingsTemplateRow,
  FeaturePresetRow,
  AutoSettingsConfigRow,
  BroadcastConfigPatch,
  BroadcastConfigRow,
  GameRewardsConfig,
  GameRewardsConfigRow,
  WelcomeConfigRow,
  WelcomeConfigPatch,
  ConsoleAdminRow,
  CrconBanRow,
  CrconImportJobPatch,
  CrconImportJobRow,
  DiscordRelayConfigPatch,
  DiscordRelayConfigRow,
  DiscordRoleMapRow,
  EventQuery,
  EventWindowQuery,
  EvtRow,
  ExternalLinkRow,
  GrantRow,
  HeartbeatRow,
  LayoutRow,
  LayoutScope,
  LeaderboardEntry,
  LeaderboardSort,
  MapNameRow,
  ObjectivePointRow, ObjectiveLayoutExpiryRow,
  MapPointPendingRow,
  MapVoteBallotRow,
  MapVoteConfigPatch,
  MapVoteConfigRow,
  MapVoteStartupState,
  PlayerStatsRow,
  RosterSampleRow,
  MapVoteHistoryRow,
  MapVotePreference,
  MapVoteStateRow,
  MapVoteTally,
  MapVoteVoterSummary,
  MatchRow,
  CrconRoundRow,
  CrconPlayerCache,
  ScoreSeriesPoint,
  MessageTemplatePatch,
  MessageTemplateRow,
  NewAnnouncement,
  NewAudit,
  NewConsoleAdmin,
  NewCrconBan,
  NewCrconImportJob,
  NewEvt,
  NewMapVoteHistory,
  NewMessageTemplate,
  NewVipPreset,
  VipPresetPatch,
  VipPresetRow,
  NewPlayerNote,
  NewPlayerTag,
  NewRole,
  NewRule,
  NewServer,
  NewVip,
  PlayerAliasRow,
  ClanSpellingRow,
  ClanGroupStatsRow,
  ClanMembersQuery,
  ClanMemberRow,
  ClanScope,
  PlayerDirectoryFilters,
  LastSeenDrift,
  PlayerDirectoryRow,
  PlayerFlagsPatch,
  PlayerFlagsRow,
  WatchHistoryRow,
  WatchReasonRow, ApprovalRequestRow, ApprovalLineRow, ApprovalRequestStatus, NewApprovalLine,
  PlayerGroupMemberRow,
  PlayerGroupEventRow,
  PlayerGroupRow,
  PlayerIpRow,
  PlayerMatchAggregate,
  PlayerMatchRow,
  PlayerMatchStatRow,
  MatchRecordKey,
  MatchStatRecord,
  ClassKillRecord,
  UnitHistoryEntry,
  PlatformBreakdown,
  PlatformTrend,
  PlatformSums,
  PlayerMix,
  PlayerNoteRow,
  PlayerRow,
  PlayerSessionRow,
  PayoutJobRow,
  PayoutItemRow,
  NewPayoutJob,
  NewPayoutItem,
  PayoutEventRow,
  PayoutEventPatch,
  EventPostConfig,
  NewPayoutEvent,
  PlayerTagRow,
  Repository,
  RoleAssignment,
  RoleRow,
  RulePatch,
  RuleSectionRow,
  RuleRow,
  RuleCheckSummary,
  RuleStatusRow,
  SeedProgressRow,
  SeedingConfigPatch,
  SeedingConfigRow,
  MapLayoutRow,
  SeedCycleRecord,
  SeedingStateRow,
  ServerConnectionPatch,
  ServerRow,
  SessionActivity,
  ScoreTrends,
  CombatActivity,
  Concurrency,
  SeenPlayer,
  RosterComposition,
  RosterSnapshotInput,
  RosterSnapshotRow,
  StaffSummaryRow,
  StatsDelta,
  TrimResult,
  TrimSpec,
  UserRow,
  VipRow,
  VipPause,
  VipGroupHold,
  VipGroupHoldSource,
  GroupVipPerk,
  MapVoteStatePatch,
  MapSetRow,
  MapZoneSetRow,
  AdminCamSessionRow,
  SignatureConfigRow,
  SignatureConfigPatch,
  AdminCamQuery,
  AdminCamConfigRow,
  AdminCamConfigPatch,
  VoteScheduleRow,
  PlayerBanRow, NewPlayerBan, BanScopeJson,
  CommunityMemberRow, EconomyLedgerRow, EconomyActivityRow, NewEconomyEntry, EconomyConfig, EconomyConfigPatch,
  DiscordCommandConfig, AppConfig, BrandImageKey, BrandImageRow, ChatFilterConfig,
  DataPortReport, DataPortTableReport,
  ImportedSession,
} from "./types.js";
import { computeKd, occupancySampleSec, foldOccupancy, foldComposition, TORN_SESSION_SEC, SESSION_MAX_SEC, GAME_SLOT_CAP, blendMeasuredConcurrency, platformFamilyTokens, emptyPlatformSums, emptyPlatformTrendRow, ANNOUNCEMENT_NUDGE_DEFAULTS, BROADCAST_DEFAULTS, WELCOME_DEFAULTS, mergeGameRewards, AUTOSETTINGS_DEFAULTS, DISCORD_RELAY_DEFAULTS, DISCORD_ALERTS_DEFAULTS, DISCORD_STATUS_BOARD_DEFAULTS, SEEDING_DEFAULTS } from "./types.js";
import { CONFIG_VERSIONS_KEPT, DATA_EXPORT_GROUPS, DATA_EXPORT_ROWS_KEPT, GROUP_EVENT_CLAIM_MS, InsufficientBalance, RuleSectionNameTaken, allDataGroups, tablesForDataGroups, type ConfigVersionKind, type ConfigVersionRow, type NewConfigVersion } from "./types.js";
import { HOUR_METRIC_KINDS, foldHourGrid, hourAverage, wholeOrNull, type DateHourRow, type HourMetric } from "./types.js";
import { MIGRATIONS } from "./migrations.js";
import { hydrateLinks, toLinks, type MapVoteLibrary } from "./map-library.js";
import { indicesOf, mapPointPicksOf } from "./map-points.js";
import { openBackupWriter } from "./backup.js";
import { CLAN_CURRENT_GRACE_SEC, normalizeClanTagSettings } from "./clan-tags.js";
import { packScoreSeries, unpackScoreSeries } from "./score-series-pack.js";
import { PACKED_SIDE_FIELDS, packComposition, packKillData, unpackComposition, unpackKillData } from "./compact-json.js";

/** Fixed key for the migration advisory lock — must match across all processes. */
const MIGRATION_LOCK_KEY = 776273;

const log = createLogger("db");

/** Lock-wait tuning, overridable via env (mostly for tests). Read at call time so tests can
 *  set them after the module is imported. */
function lockTuning(): { pollMs: number; staleMs: number; maxWaitMs: number } {
  return {
    pollMs: Number(process.env.MIGRATION_LOCK_POLL_MS ?? 2000),
    staleMs: Number(process.env.MIGRATION_LOCK_STALE_MS ?? 120_000),
    maxWaitMs: Number(process.env.MIGRATION_LOCK_WAIT_MAX_MS ?? 600_000),
  };
}

/**
 * Every board sorts on ONE metric, and ties are common — half a server sits on zero teamkills, and
 * whole ranks share a round number of kills. `ORDER BY <metric> DESC` alone leaves those tied rows
 * in whatever order the scan produced, which changes as rows are updated, so the LIMIT cut through
 * a tie differently on every refresh and players near the boundary flickered on and off the board.
 * `player_id` is arbitrary but total and stable, which is what a cut needs.
 */
const LEADERBOARD_TIEBREAK = ", p.platform_id";
const LEADERBOARD_ORDER: Record<LeaderboardSort, string> = {
  kills: "ps.kills DESC",
  deaths: "ps.deaths DESC",
  teamkills: "ps.teamkills DESC",
  kd: "(CASE WHEN ps.deaths > 0 THEN ps.kills::float / ps.deaths ELSE ps.kills END) DESC",
  // The boards that credit something other than fragging.
  combat: "ps.combat DESC",
  offense: "ps.offense DESC",
  defense: "ps.defense DESC",
  support: "ps.support DESC",
  slSeconds: "ps.sl_seconds DESC",
  playtime: "ps.playtime_sec DESC",
};

 
/**
 * Rows per batch when a trim is archiving what it deletes.
 *
 * Big enough that a large trim is not thousands of round trips, small enough that the rows held at
 * any instant are a few megabytes rather than the whole slice. The cost of a trim is now flat in
 * the number of rows removed.
 */
const TRIM_BATCH = 5_000;

/**
 * A table row as the archive files hold it (a trim's backup, a data export). A bytea value (a
 * Buffer here) is written as Postgres's own text form for bytes, `\x` and hex, which a restore
 * hands straight back to the column. JSON would spell it out as a list of numbers, which an
 * import would store as that text instead of the bytes.
 */
function archivedRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k in row) {
    const v = row[k];
    if (v instanceof Uint8Array) row[k] = `\\x${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")}`;
  }
  return row;
}

/** Rows per INSERT statement. See `events.insert` — the protocol caps parameters, not rows. */
const EVT_INSERT_CHUNK = 2_000;

function toUser(r: any): UserRow {
  return {
    id: r.id, username: r.username, passwordHash: r.password_hash ?? null, email: r.email ?? null,
    discordId: r.discord_id ?? null, discordUsername: r.discord_username ?? null,
    discordNick: r.discord_nick ?? null, discordManaged: r.discord_managed ?? false,
    announcementsSeenAt: r.announcements_seen_at ? new Date(r.announcements_seen_at).toISOString() : null,
    sessionEpoch: Number(r.session_epoch ?? 0),
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toDiscordRoleMap(r: any): DiscordRoleMapRow {
  return { discordRoleId: r.discord_role_id, discordRoleName: r.discord_role_name ?? null, roleId: r.role_id, scopeId: r.scope_id ?? null, createdAt: new Date(r.created_at).toISOString() };
}
function toBrandImage(r: any): BrandImageRow {
  return { key: r.key, mime: r.mime, bytes: new Uint8Array(r.bytes), updatedAt: new Date(r.updated_at).toISOString(), updatedBy: r.updated_by ?? null };
}
function toToken(r: any): ApiTokenRow {
  return { id: r.id, userId: r.user_id, name: r.name, tokenHash: r.token_hash, createdAt: new Date(r.created_at).toISOString(), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null };
}
function toPushSubscription(r: any): PushSubscriptionRow {
  return { endpoint: r.endpoint, userId: r.user_id, p256dh: r.p256dh, auth: r.auth, device: r.device, origin: r.origin, epoch: Number(r.epoch), createdAt: new Date(r.created_at).toISOString() };
}
/** RCON passwords are sealed at rest when ENCRYPTION_KEY is set (see @app/access seal).
 *  Read at call time so tests can set the env after import. */
const encryptionKey = (): string => process.env.ENCRYPTION_KEY ?? "";

/** An install setting as stored: sealed when it is a secret and there is a key to seal with. */
const sealInstallValue = (value: string, secret?: boolean): string => (secret && encryptionKey() ? sealSecret(value, encryptionKey()) : value);
/** An install setting as read: opened, or null when it is sealed under a key this install lacks. */
function openInstallValue(stored: string): string | null {
  try { return openSecret(stored, encryptionKey()); } catch { return null; }
}

function toServer(r: any): ServerRow {
  const nickname = ((r.nickname as string | null) ?? "").trim() || null;
  return {
    // The display resolution, done once for every read path — see ServerRow.name.
    id: r.id, name: nickname ?? r.name, gameName: r.name, game: r.game, protocol: r.protocol, host: r.host, port: r.port,
    password: openSecret(r.password, encryptionKey()), engagementMode: r.engagement_mode,
    automation: (r.automation ?? {}) as ServerRow["automation"], headerMode: r.header_mode ?? null,
    gameVersion: r.game_version ?? null, timezone: r.timezone ?? null, crconBaseUrl: r.crcon_base_url ?? null,
    streamerMode: r.streamer_mode ?? false,
    publicSlug: r.public_slug ?? null,
    publicName: r.public_name ?? null,
    nickname,
    publicPlayerIds: r.public_player_ids ?? true,
    seedSlot: r.seed_slot ?? null,
    lastContactAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : null,
    lastError: r.last_error ?? null,
    lastErrorAt: r.last_error_at ? new Date(r.last_error_at).toISOString() : null,
    retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : null,
    formerNames: Array.isArray(r.former_names) ? (r.former_names as string[]) : [],
    decommissionedAt: r.decommissioned_at ? new Date(r.decommissioned_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toGrant(r: any): GrantRow {
  return { id: r.id, userId: r.user_id, capability: r.capability, scopeType: r.scope_type, scopeId: r.scope_id ?? null, level: r.level };
}
function toRole(r: any): RoleRow {
  return {
    id: r.id, name: r.name, description: r.description ?? null,
    grants: (r.grants ?? []) as RoleRow["grants"], limits: (r.limits ?? {}) as RoleRow["limits"],
    createdByName: r.created_by_name ?? null,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toApprovalLine(r: any): ApprovalLineRow {
  return {
    id: r.id, requestId: r.request_id, seq: Number(r.seq), serverId: r.server_id ?? null,
    capability: r.capability, kind: r.kind, payload: (r.payload ?? {}) as Record<string, unknown>,
    playerId: r.player_id ?? null, playerName: r.player_name ?? null,
    state: r.state, decidedByUserId: r.decided_by_user_id ?? null, decidedByName: r.decided_by_name ?? null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    denyReason: r.deny_reason ?? null, modified: (r.modified ?? null) as ApprovalLineRow["modified"],
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null, applyError: r.apply_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toApprovalRequest(r: any, lines: ApprovalLineRow[]): ApprovalRequestRow {
  return {
    id: r.id, requesterUserId: r.requester_user_id, requesterName: r.requester_name,
    status: r.status, note: r.note ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    parkedAt: r.parked_at ? new Date(r.parked_at).toISOString() : null,
    lines,
  };
}
function toPlayer(r: any): PlayerRow {
  return { id: r.id, game: r.game, platform: r.platform, platformId: r.platform_id, name: r.name, level: r.level ?? null, firstSeen: new Date(r.first_seen).toISOString(), lastSeen: new Date(r.last_seen).toISOString() };
}
function toAlias(r: any): PlayerAliasRow {
  return { playerId: r.player_id, kind: r.kind, value: r.value, firstSeen: new Date(r.first_seen).toISOString(), lastSeen: new Date(r.last_seen).toISOString(), seenCount: Number(r.seen_count) };
}
function toLink(r: any): ExternalLinkRow {
  return { playerId: r.player_id, provider: r.provider, externalId: r.external_id, createdByName: r.created_by_name ?? null, createdAt: new Date(r.created_at).toISOString() };
}
function toTag(r: any): PlayerTagRow {
  return { id: r.id, playerId: r.player_id, label: r.label, note: r.note ?? null, createdByName: r.created_by_name, createdAt: new Date(r.created_at).toISOString() };
}
function toPayoutJob(r: any): PayoutJobRow {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceRef: (r.source_ref ?? {}) as Record<string, unknown>,
    payoutType: r.payout_type,
    amount: Number(r.amount),
    serverIds: Array.isArray(r.server_ids) ? r.server_ids.map(String) : [],
    audience: r.audience,
    dryRun: Boolean(r.dry_run),
    status: r.status,
    requestedByUserId: r.requested_by_user_id ?? null,
    requestedByName: r.requested_by_name ?? "",
    createdAt: new Date(r.created_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    totalCount: Number(r.total_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failedCount: Number(r.failed_count ?? 0),
    duplicateKey: r.duplicate_key,
  };
}
function toPayoutItem(r: any): PayoutItemRow {
  return {
    id: Number(r.id),
    jobId: r.job_id,
    playerId: r.player_id ?? null,
    discordId: r.discord_id ?? null,
    displayName: r.display_name ?? "",
    status: r.status,
    error: r.error ?? "",
    detail: (r.detail ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toPayoutEvent(r: any): PayoutEventRow {
  return {
    id: r.id,
    name: r.name,
    serverId: r.server_id,
    status: r.status,
    openMode: r.open_mode,
    openAnchor: new Date(r.open_anchor).toISOString(),
    openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    closeMode: r.close_mode,
    closeAnchor: new Date(r.close_anchor).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    minMinutes: Number(r.min_minutes ?? 0),
    mapVoteProfile: r.map_vote_profile ?? null,
    rotationSetId: r.rotation_set_id ?? null,
    rotationAppliedAt: r.rotation_applied_at ? new Date(r.rotation_applied_at).toISOString() : null,
    roster: Array.isArray(r.roster)
      ? r.roster.map((x: any) => ({ playerId: String(x.playerId), name: x.name ?? null, minutes: Number(x.minutes ?? 0) }))
      : null,
    createdBy: r.created_by ?? "",
    createdAt: new Date(r.created_at).toISOString(),
    noPayoutAt: r.no_payout_at ? new Date(r.no_payout_at).toISOString() : null,
    noPayoutBy: r.no_payout_by ?? null,
  };
}
function toSession(r: any): PlayerSessionRow {
  return { id: r.id, playerId: r.player_id, serverId: r.server_id, connectedAt: new Date(r.connected_at).toISOString(), disconnectedAt: new Date(r.disconnected_at).toISOString(), durationSec: Number(r.duration_sec) };
}
function toTemplate(r: any): MessageTemplateRow {
  return { id: r.id, kind: r.kind, title: r.title ?? "", body: r.body, sortOrder: Number(r.sort_order ?? 0), updatedAt: new Date(r.updated_at).toISOString() };
}
function toVipPreset(r: any): VipPresetRow {
  return { id: r.id, kind: r.kind, label: r.label, days: Number(r.days ?? 0), hours: Number(r.hours ?? 0), sortOrder: Number(r.sort_order ?? 0) };
}
function toAnnouncement(r: any): AnnouncementRow {
  return {
    id: r.id, title: r.title, body: r.body, published: r.published,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    nudgedAt: r.nudged_at ? new Date(r.nudged_at).toISOString() : null,
    authorUserId: r.author_user_id ?? null,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toAnnouncementRead(r: any): AnnouncementReadRow {
  return {
    announcementId: r.announcement_id, userId: r.user_id,
    readAt: new Date(r.read_at).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
  };
}
function toRule(r: any): RuleRow {
  return {
    id: r.id, name: r.name, enabled: r.enabled, serverId: r.server_id ?? null, eventKind: r.event_kind, match: r.match ?? null,
    threshold: r.threshold, windowSec: r.window_sec, action: r.action, reason: r.reason ?? null, hours: r.hours ?? null,
    delaySec: r.delay_sec ?? 0, vipMinutes: r.vip_minutes ?? 10, vipCooldownMinutes: r.vip_cooldown_minutes ?? 60,
    requireRoleIds: Array.isArray(r.require_role_ids) ? r.require_role_ids : [],
    immuneTags: Array.isArray(r.immune_tags) ? r.immune_tags : [],
    immuneRoleIds: Array.isArray(r.immune_role_ids) ? r.immune_role_ids : [],
    immuneLevel: Number(r.immune_level ?? 0),
    dryRun: r.dry_run ?? false,
    escalateActions: Array.isArray(r.escalate_actions) ? r.escalate_actions : [],
    escalateResetMinutes: Number(r.escalate_reset_minutes ?? 120),
    // Absent on a row written before the column: a rule that never opted out still pings.
    alertEnabled: r.alert_enabled ?? true,
    alertChannelId: r.alert_channel_id ?? null,
    params: r.params && typeof r.params === "object" ? r.params : null,
    activeHours: r.active_hours && typeof r.active_hours === "object" ? r.active_hours : null,
    playersMin: Number(r.players_min ?? 0),
    playersMax: Number(r.players_max ?? 0),
    breakerLimit: Number(r.breaker_limit ?? 10),
    matchMinutesMin: Number(r.match_minutes_min ?? 0),
    matchMinutesMax: Number(r.match_minutes_max ?? 0),
    countPerMatch: r.count_per_match ?? false,
    requireTags: Array.isArray(r.require_tags) ? r.require_tags : [],
    capCount: Number(r.cap_count ?? 0),
    capPeriod: (r.cap_period ?? "day") as RuleRow["capPeriod"],
    actionTag: r.action_tag ?? null,
    points: Number(r.points ?? 0),
    sectionId: r.section_id ?? null,
    // From RULE_SELECT's join — every read of a rule goes through it, writes included.
    sectionOff: r.section_off === true,
    pausedUntil: r.paused_until ? new Date(r.paused_until).toISOString() : null,
    pauseReason: r.pause_reason ?? null,
    pausedBy: r.paused_by ?? null,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
/** A rule row with its section's master switch read alongside: `FROM <source> r` (a table or a
 *  CTE of the written rows), so a write returns the same shape a read does. */
const RULE_SELECT = (source: string) => `SELECT r.*, (s.enabled IS FALSE) AS section_off FROM ${source} r LEFT JOIN rule_sections s ON s.id = r.section_id`;
function toConfigVersion(r: any): ConfigVersionRow {
  return {
    id: r.id, kind: r.kind, targetId: r.target_id, targetName: r.target_name ?? null, change: r.change,
    before: r.before ?? null, after: r.after ?? null, actorUserId: r.actor_user_id ?? null, actorName: r.actor_name ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toRuleSection(r: any): RuleSectionRow {
  return { id: r.id, name: r.name, enabled: r.enabled !== false, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() };
}
/**
 * Resolve a player's CURRENT name for rows that keep their own copy of it.
 *
 * VIPs, console admins, ban decisions and group memberships each store `player_name` at the
 * moment they were created. Hell Let Loose players rename constantly, so those copies go stale the
 * first time someone changes their tag: the VIP list would still be showing the name they had when
 * the entry was granted, sometimes years earlier, while the roster next to it shows the new one.
 *
 * Rather than write the copy back on every rename (which would need a sweep over five tables and
 * would still lose races), the copy is treated as what it is — a fallback. The join wins when we
 * know the player; the stored name is used only for rows whose player id we have never seen,
 * which happens when an entry is added by raw platform id before that player has ever joined.
 *
 * The historical names are not lost: player_aliases keeps every name a player has been seen under,
 * and the profile shows that history.
 *
 * The join is on players.platform_id, NOT players.id. These tables hold the raw platform id (the
 * value handed straight to the game server's addVip), because an entry can be created for someone
 * who has never joined — pasting a Steam id is a supported way to add a VIP or ban a player.
 */
const CURRENT_NAME = (alias: string) =>
  `coalesce(nullif(pl.name, ''), ${alias}.player_name) AS player_name`;
const JOIN_PLAYER = (alias: string) => `LEFT JOIN players pl ON pl.platform_id = ${alias}.player_id`;

// The same "resolve the name at read time" idea for the event log — but `evt` stores our INTERNAL
// player id, not the platform id the VIP/ban tables key on, so it needs its own join. A
// player who renamed shows their current name on every past kill, exactly like the audit trail.
/** Below this many seconds a session counts as "joined and left". Five minutes is long enough to
 *  load in and look around, short enough that staying is a decision. Inlined into SQL rather than
 *  bound, so it must stay a literal number — it is one, right here, and never user input. */
const SHORT_SESSION_SEC = 300;

/**
 * The platform split's two grouped scans share their columns between the window and the per-day
 * series, so the sums are written once. Sessions: presence, and how long it lasted. `newWhen` is
 * the condition that makes a player new in the bucket being grouped (first seen in the window, or
 * on that day). Rounds: everything a finished round adds up, for the page to derive ratios from.
 */
const PLATFORM_SESSION_SUMS = (newWhen: string) =>
  `count(DISTINCT s.player_id)::int AS players,
   count(DISTINCT s.player_id) FILTER (WHERE ${newWhen})::int AS new_players,
   count(*)::int AS sessions,
   count(*) FILTER (WHERE s.duration_sec < ${SHORT_SESSION_SEC})::int AS short,
   coalesce(sum(s.duration_sec), 0)::bigint AS playtime`;
const PLATFORM_ROUND_SUMS =
  `count(*)::int AS rounds,
   coalesce(sum(st.kills), 0)::bigint AS kills, coalesce(sum(st.deaths), 0)::bigint AS deaths,
   coalesce(sum(st.teamkills), 0)::bigint AS teamkills, coalesce(sum(st.vehicle_kills), 0)::bigint AS vehicle_kills,
   count(*) FILTER (WHERE st.combat + st.offense + st.defense + st.support > 0)::int AS scored_rounds,
   coalesce(sum(st.combat), 0)::bigint AS combat, coalesce(sum(st.offense), 0)::bigint AS offense,
   coalesce(sum(st.defense), 0)::bigint AS defense, coalesce(sum(st.support), 0)::bigint AS support,
   coalesce(sum(st.sl_seconds), 0)::bigint AS sl_seconds`;
function foldPlatformSessions(row: PlatformSums, r: any): void {
  row.players = Number(r.players); row.newPlayers = Number(r.new_players);
  row.sessions = Number(r.sessions); row.shortSessions = Number(r.short);
  row.playtimeSec = Number(r.playtime);
}
function foldPlatformRounds(row: PlatformSums, r: any): void {
  row.rounds = Number(r.rounds); row.kills = Number(r.kills); row.deaths = Number(r.deaths);
  row.teamkills = Number(r.teamkills); row.vehicleKills = Number(r.vehicle_kills);
  row.scoredRounds = Number(r.scored_rounds);
  row.combat = Number(r.combat); row.offense = Number(r.offense); row.defense = Number(r.defense); row.support = Number(r.support);
  row.slSeconds = Number(r.sl_seconds);
}

const JOIN_EVT_ACTOR = "LEFT JOIN players pl ON pl.id = e.actor_player_id";
const EVT_ACTOR_NAME = "coalesce(nullif(pl.name, ''), e.actor_name, 'Unknown')";

function toVip(r: any): VipRow {
  return {
    id: r.id, serverId: r.server_id, playerId: r.player_id, playerName: r.player_name ?? null,
    comment: r.comment ?? null, expiration: r.expiration ? new Date(r.expiration).toISOString() : null,
    pausedUntil: r.paused_until ? new Date(r.paused_until).toISOString() : null,
    pauseReason: r.pause_reason ?? null, pausedBy: r.paused_by ?? null,
    pauseMode: r.pause_mode ?? null, pausedAt: r.paused_at ? new Date(r.paused_at).toISOString() : null,
    groupHold: toVipGroupHold(r.group_hold),
    createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
/** The hold as stored (jsonb), read defensively: an unreadable hold is still a hold — its row
 *  stays permanent — with nothing banked and no groups remembered. */
function toVipGroupHold(raw: any): VipGroupHold | null {
  if (!raw || typeof raw !== "object") return null;
  const since = typeof raw.since === "string" && Number.isFinite(Date.parse(raw.since)) ? new Date(raw.since).toISOString() : new Date(0).toISOString();
  const banked = Number(raw.bankedMs);
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter((g: any) => g && typeof g.id === "string").map((g: any) => ({ id: g.id, name: typeof g.name === "string" ? g.name : "", severanceMinutes: Math.max(0, Number(g.severanceMinutes) || 0) }))
    : [];
  return { since, bankedMs: Number.isFinite(banked) ? Math.max(0, Math.round(banked)) : 0, groups };
}
/** A group's perk as stored, read defensively: a shape nobody can act on reads as no perk. */
function toGroupVipPerk(raw: any): GroupVipPerk | null {
  if (!raw || typeof raw !== "object" || typeof raw.game !== "string" || !raw.scope || typeof raw.scope !== "object") return null;
  const mode = raw.scope.mode;
  const ids = Array.isArray(raw.scope.serverIds) ? raw.scope.serverIds.filter((x: unknown) => typeof x === "string") : [];
  const scope: BanScopeJson | null = mode === "all" ? { mode: "all" } : mode === "except" ? { mode: "except", serverIds: ids } : mode === "servers" ? { mode: "servers", serverIds: ids } : null;
  if (!scope) return null;
  return { game: raw.game, scope, severanceMinutes: Math.max(0, Math.round(Number(raw.severanceMinutes) || 0)), bankRewards: raw.bankRewards !== false };
}

function toPlayerTrigger(r: any): PlayerTriggerRow {
  const raw = Array.isArray(r.steps) ? r.steps : [];
  return {
    id: r.id,
    playerId: r.player_id,
    playerName: r.player_name ?? null,
    serverId: r.server_id ?? null,
    event: r.event,
    steps: raw.map((st: any) => ({
      action: st.action,
      message: st.message ?? null,
      hours: Number(st.hours) || 0,
      points: Number(st.points) || 0,
      delaySec: Number(st.delaySec) || 0,
    })),
    fireOnce: r.fire_once,
    enabled: r.enabled,
    note: r.note ?? null,
    createdByUserId: r.created_by_user_id ?? null,
    createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
    firedCount: Number(r.fired_count) || 0,
    lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
    disarmedAt: r.disarmed_at ? new Date(r.disarmed_at).toISOString() : null,
    params: r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {},
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    updatedByName: r.updated_by_name ?? null,
  };
}
function toConsoleAdmin(r: any): ConsoleAdminRow {
  return {
    id: r.id, serverId: r.server_id, playerId: r.player_id, playerName: r.player_name ?? null,
    adminGroup: r.admin_group, comment: r.comment ?? null,
    expiration: r.expiration ? new Date(r.expiration).toISOString() : null,
    createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toPlayerGroup(r: any): PlayerGroupRow {
  return {
    id: r.id, name: r.name, description: r.description ?? null, memberCount: Number(r.member_count ?? 0),
    vipPerk: toGroupVipPerk(r.vip_perk),
    discordRoleId: typeof r.discord_role_id === "string" && r.discord_role_id ? r.discord_role_id : null,
    createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toPlayerGroupMember(r: any): PlayerGroupMemberRow {
  return {
    groupId: r.group_id, playerId: r.player_id, playerName: r.player_name ?? null,
    addedByName: r.added_by_name, addedAt: new Date(r.added_at).toISOString(),
    source: r.source === "discord" ? "discord" : "panel",
  };
}
function toHeartbeat(r: any): HeartbeatRow {
  return { name: r.name, status: r.status, detail: r.detail ?? null, updatedAt: new Date(r.updated_at).toISOString() };
}
function toMapLayout(r: Record<string, unknown>): MapLayoutRow {
  return {
    mapId: String(r.map_id), xNeg: Number(r.x_neg ?? 0), xPos: Number(r.x_pos ?? 0),
    yNeg: Number(r.y_neg ?? 0), yPos: Number(r.y_pos ?? 0), separation: Number(r.separation ?? 0),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function toSeedingConfig(r: any): SeedingConfigRow {
  return {
    serverId: r.server_id, enabled: r.enabled, dryRun: r.dry_run,
    seedTarget: Number(r.seed_target), minPlayers: Number(r.min_players),
    disallowedRoles: (r.disallowed_roles ?? []) as number[],
    disallowedWeaponClasses: (r.disallowed_weapon_classes ?? []) as string[],
    disallowedWeapons: (r.disallowed_weapons ?? []) as string[],
    disallowedWeaponNames: (r.disallowed_weapon_names ?? []) as string[],
    disallowedCommanderAbilities: (r.disallowed_commander_abilities ?? []) as string[],
    capFightEnabled: r.cap_fight_enabled ?? false,
    capFightMaxCaps: Number(r.cap_fight_max_caps ?? 3),
    capFightSkipWarning: r.cap_fight_skip_warning ?? false,
    capFightNotice: r.cap_fight_notice ?? "",
    containEnabled: r.contain_enabled ?? false,
    containAutoEnabled: r.contain_auto_enabled ?? false,
    positionalEnabled: r.positional_enabled ?? false,
    paceEnabled: r.pace_enabled ?? false,
    paceUnlockMinutes: (r.pace_unlock_minutes ?? [0, 0, 20, 40, 60]) as number[],
    paceNotice: r.pace_notice ?? "",
    layoutLearnEnabled: r.layout_learn_enabled ?? true,
    containGraceSec: Number(r.contain_grace_sec ?? 60),
    containMaxPlayers: Number(r.contain_max_players ?? 60),
    containNotice: r.contain_notice ?? "",
    containZones: (r.contain_zones ?? {}) as SeedingConfigRow["containZones"],
    immuneLevel: Number(r.immune_level),
    immuneTags: (r.immune_tags ?? []) as string[], announceMessage: r.announce_message ?? "",
    maxWarnings: Number(r.max_warnings), warnIntervalSec: Number(r.warn_interval_sec), warnMessage: r.warn_message ?? "",
    maxPunishes: Number(r.max_punishes), punishIntervalSec: Number(r.punish_interval_sec), punishMessage: r.punish_message ?? "",
    kickAfter: r.kick_after, kickMessage: r.kick_message ?? "",
    rewardEnabled: r.reward_enabled, rewardHours: Number(r.reward_hours), rewardPoints: Number(r.reward_points ?? 0),
    minSeedMinutes: Number(r.min_seed_minutes),
    rewardCumulative: r.reward_cumulative, rewardMessage: r.reward_message ?? "",
    rewardLinkedNote: r.reward_linked_note ?? "", rewardUnlinkedNote: r.reward_unlinked_note ?? "",
    rewardBridge: (r.reward_bridge ?? []) as SeedingConfigRow["rewardBridge"],
    rewardDelaySec: Number(r.reward_delay_sec ?? 0),
    rewardRepeatMessage: r.reward_repeat_message ?? SEEDING_DEFAULTS.rewardRepeatMessage,
    phaseConfirmSec: Number(r.phase_confirm_sec ?? 0), phaseHysteresis: Number(r.phase_hysteresis ?? 0),
    checkSec: r.check_sec == null ? null : Number(r.check_sec),
    chaseCheckSec: r.chase_check_sec == null ? null : Number(r.chase_check_sec),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toBroadcastConfig(r: any): BroadcastConfigRow {
  return {
    serverId: r.server_id, enabled: r.enabled, dryRun: r.dry_run,
    intervalSec: Number(r.interval_sec), randomize: r.randomize,
    messages: (r.messages ?? []) as string[],
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toWelcomeConfig(r: any): WelcomeConfigRow {
  return {
    serverId: r.server_id, enabled: r.enabled, template: r.template ?? "", intervalSec: Number(r.interval_sec),
    lastText: r.last_text ?? null,
    lastWrittenAt: r.last_written_at ? new Date(r.last_written_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function mergeDiscordAlerts(raw: any): DiscordRelayConfigRow["alerts"] {
  const a = (raw ?? {}) as any;
  return {
    adminPing: { ...DISCORD_ALERTS_DEFAULTS.adminPing, ...(a.adminPing ?? {}) },
    watchlist: { ...DISCORD_ALERTS_DEFAULTS.watchlist, ...(a.watchlist ?? {}) },
    automation: { ...DISCORD_ALERTS_DEFAULTS.automation, ...(a.automation ?? {}) },
    serverDark: { ...DISCORD_ALERTS_DEFAULTS.serverDark, ...(a.serverDark ?? {}) },
  };
}
function toDiscordRelayConfig(r: any): DiscordRelayConfigRow {
  return {
    serverId: r.server_id, enabled: r.enabled,
    categories: (r.categories ?? []) as string[],
    channels: (r.channels ?? {}) as Record<string, string | null>,
    categoryOptions: (r.category_options ?? {}) as DiscordRelayConfigRow["categoryOptions"],
    alerts: mergeDiscordAlerts(r.alerts),
    statusBoard: { ...DISCORD_STATUS_BOARD_DEFAULTS, ...((r.status_board ?? {}) as object) },
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toAutoSettingsConfig(r: any): AutoSettingsConfigRow {
  return {
    serverId: r.server_id, enabled: r.enabled, dryRun: r.dry_run,
    timezone: r.timezone ?? "UTC",
    profiles: (r.profiles ?? []) as AutoSettingsConfigRow["profiles"],
    matchMessages: (r.match_messages ?? []) as AutoSettingsConfigRow["matchMessages"],
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toAutoSettingsTemplate(r: any): AutoSettingsTemplateRow {
  return {
    id: r.id, name: r.name,
    config: (r.config ?? {}) as AutoSettingsTemplateRow["config"],
    createdByName: r.created_by_name, updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toFeaturePreset(r: any): FeaturePresetRow {
  return {
    id: r.id, feature: r.feature, name: r.name,
    config: (r.config ?? {}) as Record<string, unknown>,
    game: r.game ?? null,
    createdByName: r.created_by_name, updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toSeedProgress(r: any): SeedProgressRow {
  return { serverId: r.server_id, playerId: r.player_id, playerName: r.player_name ?? null, seconds: Number(r.seconds), updatedAt: new Date(r.updated_at).toISOString() };
}
function toSeedingState(r: any): SeedingStateRow {
  return { serverId: r.server_id, phase: r.phase, liveCount: Number(r.live_count), seederCount: Number(r.seeder_count), lastRewardAt: r.last_reward_at ? new Date(r.last_reward_at).toISOString() : null, updatedAt: new Date(r.updated_at).toISOString(), payRequested: r.pay_requested_at != null };
}
function toMapName(r: any): MapNameRow {
  return { game: r.game, mapId: r.map_id, displayName: r.display_name ?? null, family: r.family ?? null, updatedAt: new Date(r.updated_at).toISOString() };
}
function toLayoutExpiry(r: Record<string, unknown>): ObjectiveLayoutExpiryRow {
  return {
    serverId: String(r.server_id), mapId: String(r.map_id),
    playsLeft: Number(r.plays_left), lastMatchId: r.last_match_id == null ? null : String(r.last_match_id),
    setBy: String(r.set_by ?? ""), updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function toMapPointPending(r: any): MapPointPendingRow {
  return {
    serverId: r.server_id, id: r.id, game: r.game, mapKey: r.map_key, modeKey: r.mode_key,
    mapId: r.map_id, beforeMapId: r.before_map_id ?? null, phase: r.phase,
    picks: mapPointPicksOf(r.picks),
    storedMapId: r.stored_map_id ?? null, storedIndices: indicesOf(r.stored_indices),
    carriedIndices: indicesOf(r.carried_indices), restore: indicesOf(r.restore),
    baselineMatchId: r.baseline_match_id ?? null, requestedBy: r.requested_by ?? "",
    requestedAt: new Date(r.requested_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
  };
}

function toObjectivePoint(r: any): ObjectivePointRow {
  return { game: r.game, mapKey: r.map_key, row: Number(r.row_no), idx: Number(r.idx), name: r.name ?? null, sector: r.sector ?? null, updatedAt: new Date(r.updated_at).toISOString() };
}
function toPlayerStats(r: any): PlayerStatsRow {
  return {
    playerId: r.player_id, serverId: r.server_id ?? null,
    kills: r.kills, deaths: r.deaths, teamkills: r.teamkills,
    visits: r.visits ?? 0, playtimeSec: Number(r.playtime_sec ?? 0),
    combat: Number(r.combat ?? 0), offense: Number(r.offense ?? 0),
    defense: Number(r.defense ?? 0), support: Number(r.support ?? 0),
    vehicleKills: Number(r.vehicle_kills ?? 0), vehiclesDestroyed: Number(r.vehicles_destroyed ?? 0),
    roleSeconds: (r.role_seconds ?? {}) as Record<string, number>,
    slSeconds: Number(r.sl_seconds ?? 0), highestLevel: Number(r.highest_level ?? 0),
    matchesPlayed: Number(r.matches_played ?? 0), matchesWon: Number(r.matches_won ?? 0),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toSignatureConfig(r: any): SignatureConfigRow {
  return {
    staffLine: r.staff_line ?? SIGNATURE_DEFAULTS.staffLine,
    customLine: r.custom_line ?? SIGNATURE_DEFAULTS.customLine,
    // Coerced through the shared parser rather than trusted: an action key that is no longer
    // signable must not survive a round trip and reappear in the editor.
    actions: parseSignatureActions(r.actions),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toAdminCamSession(r: any): AdminCamSessionRow {
  return {
    id: r.id, serverId: r.server_id, playerId: r.player_id ?? null, playerName: r.player_name,
    enteredAt: new Date(r.entered_at).toISOString(),
    exitedAt: r.exited_at ? new Date(r.exited_at).toISOString() : null,
    durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
  };
}
function toAdminCamConfig(r: any): AdminCamConfigRow {
  return {
    serverId: r.server_id, notifyEnabled: r.notify_enabled ?? false,
    enterMessage: r.enter_message ?? "", exitMessage: r.exit_message ?? "",
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toMapSet(r: any): MapSetRow {
  return {
    id: r.id, name: r.name, game: r.game, pool: (r.pool ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toVoteSchedule(r: any): VoteScheduleRow {
  return {
    id: r.id, name: r.name, spec: (r.spec ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toMapZoneSet(r: any): MapZoneSetRow {
  return {
    id: r.id, name: r.name, game: r.game, zones: (r.zones ?? {}) as MapZoneSetRow["zones"],
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toMapVoteConfig(r: any, library: MapVoteLibrary): MapVoteConfigRow {
  const links = toLinks(r.profiles);
  return {
    serverId: r.server_id, enabled: r.enabled ?? false, surface: r.surface ?? "native",
    channelId: r.channel_id ?? null, pollHours: Number(r.poll_hours ?? 24),
    timezone: r.timezone ?? "UTC",
    profiles: hydrateLinks(links, library), profileLinks: links,
    reminders: (r.reminders ?? []) as MapVoteConfigRow["reminders"],
    liveApply: r.live_apply ?? true,
    postMatchApplyDelaySeconds: Number(r.post_match_apply_delay_seconds ?? 300),
    pollResetDelaySeconds: Number(r.poll_reset_delay_seconds ?? 180),
    tidyChannel: r.tidy_channel !== false,
    pauseBelowPlayers: Number(r.pause_below_players ?? 0),
    registeredOnlyIngame: r.registered_only_ingame ?? false,
    registeredOnlyDiscord: r.registered_only_discord ?? false,
    startupState: normalizeStartupState(r.startup_state),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
/** An unknown value in the column reads as "remember" — the do-nothing posture — rather than
 *  throwing or silently pausing a server's vote. */
function normalizeStartupState(v: unknown): MapVoteStartupState {
  return (MAPVOTE_STARTUP_STATES as readonly string[]).includes(String(v)) ? (v as MapVoteStartupState) : "remember";
}
function toMapVoteHistory(r: any): MapVoteHistoryRow {
  return {
    id: r.id, serverId: r.server_id, decidedAt: new Date(r.decided_at).toISOString(),
    profile: r.profile ?? null, options: (r.options ?? []) as { id: string; name: string; votes: number }[],
    winnerId: r.winner_id ?? null, winnerName: r.winner_name ?? null,
    totalVotes: Number(r.total_votes ?? 0), outcome: r.outcome ?? "vote", applied: r.applied ?? false,
  };
}
function toMapVoteBallot(r: any): MapVoteBallotRow {
  return {
    id: r.id, historyId: r.history_id, serverId: r.server_id,
    decidedAt: new Date(r.decided_at).toISOString(),
    mapId: r.map_id, mapName: r.map_name || r.map_id,
    discordUserId: r.discord_user_id, discordName: r.discord_name || r.discord_user_id,
    won: r.won ?? false,
  };
}
/**
 * The stored in-game voter list, rebuilt in the row's own key order. jsonb sorts an object's keys
 * (shorter first), so it reads back as {voters, messageId}; the worker compares the list it read
 * with the one it means to write by their JSON, and read raw it saw a change on every tick.
 */
function ingameVotersOf(v: any): MapVoteStateRow["ingameVoters"] {
  if (!v || typeof v.messageId !== "string" || !Array.isArray(v.voters)) return null;
  return {
    messageId: v.messageId,
    voters: v.voters.map((list: any) => (Array.isArray(list) ? list : []).map((x: any) => ({
      name: String(x?.name ?? ""), playerId: typeof x?.playerId === "string" ? x.playerId : null,
    }))),
  };
}

function toMapVoteState(r: any): MapVoteStateRow {
  return {
    serverId: r.server_id, activeMessageId: r.active_message_id ?? null, activeChannelId: r.active_channel_id ?? null,
    options: (r.options ?? []) as { id: string; name: string }[], profile: r.profile ?? null,
    openedAt: r.opened_at ? new Date(r.opened_at).toISOString() : null,
    lastMatchEndAt: r.last_match_end_at ? new Date(r.last_match_end_at).toISOString() : null,
    paused: r.paused ?? false, pauseReason: r.pause_reason ?? null,
    savedOptions: (r.saved_options ?? []) as { id: string; name: string }[],
    pauseNoticeId: r.pause_notice_id ?? null,
    overrideMapId: r.override_map_id ?? null,
    recentMaps: (r.recent_maps ?? []) as string[],
    tallies: (r.tallies ?? []) as number[],
    talliedAt: r.tallied_at ? new Date(r.tallied_at).toISOString() : null,
    lastClosedMessageId: r.last_closed_message_id ?? null, lastClosedChannelId: r.last_closed_channel_id ?? null,
    skipNext: r.skip_next ?? false, reroll: r.reroll ?? false,
    startNow: r.start_now ?? false, resyncNow: r.resync_now ?? false,
    sendMessageLayout: r.send_message_layout ?? null,
    liveAppliedMapId: r.live_applied_map_id ?? null,
    ingameVoters: ingameVotersOf(r.ingame_voters),
    liveApplyNote: r.live_apply_note ?? null,
    reopenAt: r.reopen_at ? new Date(r.reopen_at).toISOString() : null,
    manualHoldUntil: r.manual_hold_until ? new Date(r.manual_hold_until).toISOString() : null,
    lastOpenError: r.last_open_error ?? null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toPlayerBan(r: any): PlayerBanRow {
  return {
    id: r.id, game: r.game, playerId: r.player_id, playerName: r.player_name ?? null,
    kind: r.kind, reason: r.reason, category: r.category ?? null,
    // jsonb comes back parsed; a string would mean a driver change, and guessing is worse than throwing.
    scope: (typeof r.scope === "string" ? JSON.parse(r.scope) : r.scope) as BanScopeJson,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
    liftedAt: r.lifted_at ? new Date(r.lifted_at).toISOString() : null,
    liftedByName: r.lifted_by_name ?? null,
  };
}
function toCrconBan(r: any): CrconBanRow {
  return {
    id: r.id, serverId: r.server_id, playerId: r.player_id, playerName: r.player_name ?? null,
    type: r.type, reason: r.reason ?? null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    author: r.author ?? null, createdAt: new Date(r.created_at).toISOString(),
  };
}
function toMember(r: any): CommunityMemberRow {
  return {
    discordId: r.discord_id, discordName: r.discord_name ?? null, balance: r.balance,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toLedger(r: any): EconomyLedgerRow {
  return {
    id: r.id, discordId: r.discord_id, delta: r.delta, reason: r.reason,
    ref: r.ref ?? null, actorName: r.actor_name ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
/** A server's rounds as the CRCON-compatible endpoints list them: ours, and the short copies ($1 = server). */
const CRCON_ROUND_COLS = `seq, game, map, crcon_map, crcon_guessed, crcon_initial_morale, crcon_end_deferred, started_at, ended_at,
  cap_flips, morale_history, match_time, sector_layout, allied_score, axis_score, result, created_at`;
const CRCON_ROUNDS_SQL = `SELECT id::text AS match_id, false AS short, settled_at, ${CRCON_ROUND_COLS} FROM matches WHERE server_id = $1
  UNION ALL
  SELECT NULL AS match_id, true AS short, NULL::timestamptz AS settled_at, ${CRCON_ROUND_COLS} FROM crcon_short_rounds WHERE server_id = $1`;

function toCrconRound(r: any): CrconRoundRow {
  return {
    matchId: r.match_id ?? null, short: r.short === true, seq: Number(r.seq ?? 0), game: r.game ?? null, map: r.map ?? null,
    crconMap: r.crcon_map ?? null, crconGuessed: r.crcon_guessed ?? null, crconInitialMorale: r.crcon_initial_morale ?? null,
    crconEndDeferred: r.crcon_end_deferred ?? null,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    capFlips: Array.isArray(r.cap_flips) ? r.cap_flips : [],
    moraleHistory: Array.isArray(r.morale_history) ? r.morale_history : [],
    matchTime: Number(r.match_time ?? 0),
    sectorLayout: Array.isArray(r.sector_layout) ? (r.sector_layout as string[]) : null,
    alliedScore: r.allied_score ?? null, axisScore: r.axis_score ?? null, result: r.result ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
  };
}
function toMatch(r: any): MatchRow {
  return {
    id: r.id, seq: Number(r.seq ?? 0), serverId: r.server_id, game: r.game ?? null, map: r.map ?? null,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    winner: r.winner ?? null, alliedScore: r.allied_score ?? null, axisScore: r.axis_score ?? null,
    initialMorale: r.initial_morale ?? null, alliedMorale: r.allied_morale ?? null, axisMorale: r.axis_morale ?? null,
    capFlips: Array.isArray(r.cap_flips) ? r.cap_flips : [],
    moraleHistory: Array.isArray(r.morale_history) ? r.morale_history : [],
    matchTime: Number(r.match_time ?? 0),
    crconMap: r.crcon_map ?? null,
    crconGuessed: r.crcon_guessed ?? null,
    crconInitialMorale: r.crcon_initial_morale ?? null,
    crconEndDeferred: r.crcon_end_deferred ?? null,
    result: r.result ?? null,
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    sectorLayout: Array.isArray(r.sector_layout) ? (r.sector_layout as string[]) : null,
    sectorLayoutBy: r.sector_layout_by ?? null,
    sectorLayoutAt: r.sector_layout_at ? new Date(r.sector_layout_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function toMatchStat(r: any): PlayerMatchStatRow {
  return {
    matchId: r.match_id, playerId: r.player_id, serverId: r.server_id, playerName: r.player_name ?? null,
    side: r.side ?? null, kills: r.kills, deaths: r.deaths, teamkills: r.teamkills,
    combat: Number(r.combat ?? 0), offense: Number(r.offense ?? 0),
    defense: Number(r.defense ?? 0), support: Number(r.support ?? 0),
    vehicleKills: Number(r.vehicle_kills ?? 0), vehiclesDestroyed: Number(r.vehicles_destroyed ?? 0),
    roleSeconds: (r.role_seconds ?? {}) as Record<string, number>,
    slSeconds: Number(r.sl_seconds ?? 0),
    killsAndAssists: Number(r.kills_and_assists ?? 0),
    killsAndAssistsPrev: Number(r.kills_and_assists_prev ?? 0),
    deathsAndRedeploys: Number(r.deaths_and_redeploys ?? 0),
    deathsAndRedeploysPrev: Number(r.deaths_and_redeploys_prev ?? 0),
    units: Array.isArray(r.units) ? (r.units as UnitHistoryEntry[]) : [],
    won: r.won ?? null, presentAtEnd: r.present_at_end ?? null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toCrconJob(r: any): CrconImportJobRow {
  return {
    id: r.id, serverId: r.server_id, baseUrl: r.base_url, status: r.status,
    cursor: (r.cursor ?? {}) as Record<string, unknown>, counts: (r.counts ?? {}) as Record<string, number>,
    errors: (r.errors ?? []) as string[], createdByUserId: r.created_by_user_id ?? null, createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function toNote(r: any): PlayerNoteRow {
  return { id: r.id, playerId: r.player_id, authorUserId: r.author_user_id ?? null, authorName: r.author_name, body: r.body, createdAt: new Date(r.created_at).toISOString() };
}
function toPlayerIp(r: any): PlayerIpRow {
  return {
    playerId: r.player_id, ip: r.ip,
    firstSeen: new Date(r.first_seen).toISOString(),
    lastSeen: new Date(r.last_seen).toISOString(),
    seenCount: Number(r.seen_count), source: r.source,
  };
}

function toFlags(r: any): PlayerFlagsRow {
  return {
    playerId: r.player_id, watchlist: r.watchlist, vip: r.vip,
    updatedByName: r.updated_by_name ?? null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    watchReason: r.watch_reason ?? null, watchBy: r.watch_by ?? null,
    watchAt: r.watch_at ? new Date(r.watch_at).toISOString() : null,
  };
}
function toWatchReason(r: any): WatchReasonRow {
  return {
    id: r.id, playerId: r.player_id, reason: r.reason,
    addedBy: r.added_by ?? null, addedByUserId: r.added_by_user_id ?? null,
    addedAt: new Date(r.added_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    removedBy: r.removed_by ?? null, removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null,
    edits: Array.isArray(r.edits) ? r.edits : [],
  };
}
/** The VIP integrity scan's slice of the audit trail — word for word the predicate of migration
 *  137's partial index (audit_vip_timeline_idx), which is what lets the planner use it. */
export const VIP_TIMELINE_SQL = `action IN (${VIP_TIMELINE_ACTIONS.map((a) => `'${a}'`).join(", ")})
           OR (action IN (${VIP_TIMELINE_EXPIRY_ACTIONS.map((a) => `'${a}'`).join(", ")}) AND data->>'expiration' IS NOT NULL)`;

function toAudit(r: any): AuditRow {
  return {
    id: r.id,
    ts: new Date(r.ts).toISOString(),
    actorUserId: r.actor_user_id ?? null,
    actorName: r.actor_name,
    action: r.action,
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    targetName: r.target_name ?? null,
    serverId: r.server_id ?? null,
    summary: r.summary,
    data: r.data ?? null,
    automated: r.automated ?? false,
  };
}
function toEvt(r: any): EvtRow {
  return {
    id: r.id, serverId: r.server_id, ts: new Date(r.ts).toISOString(), kind: r.kind,
    actorPlayerId: r.actor_player_id ?? null, actorName: r.actor_name ?? null,
    victimPlayerId: r.victim_player_id ?? null, victimName: r.victim_name ?? null,
    weapon: r.weapon ?? null, data: unpackKillData(r.kind, r.data), dedupeKey: r.dedupe_key ?? null,
  };
}

/**
 * What a search box holds, as an ILIKE pattern that finds exactly that text anywhere in a field.
 * `%` and `_` are wildcards to LIKE and `\` its escape, so a search typed as "a_b" also found
 * "axb", a lone "_" matched everybody, and "100%" matched "1000" — while the memory store, which
 * matches plain text, found only what was typed. Escaped, the two stores answer alike.
 */
function containsLike(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** The audit trail's WHERE clause, shared by its listing and its count. */
function auditWhere(query: AuditQuery): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, val: unknown) => { args.push(val); where.push(sql.replace("?", `$${args.length}`)); };
  if (query.actorUserId) add("actor_user_id = ?", query.actorUserId);
  if (query.action) add("action = ?", query.action);
  if (query.actions?.length) add("action = ANY(?)", query.actions);
  if (query.targetId) add("target_id = ?", query.targetId);
  // Both server filters keep community-wide rows when the caller says the narrowing is a view
  // choice rather than a permission boundary — see AuditQuery.includeUnscoped.
  if (query.serverId) add(query.includeUnscoped ? "(server_id = ? OR server_id IS NULL)" : "server_id = ?", query.serverId);
  // A scoped read is "what happened on these servers", so rows with no server are not in it.
  if (query.serverIds) add(query.includeUnscoped ? "(server_id = ANY(?) OR server_id IS NULL)" : "server_id = ANY(?)", query.serverIds);
  if (query.from) add("ts >= ?", query.from);
  if (query.to) add("ts < ?", query.to);
  // The flag stored at write time — see AuditQuery.actor for why this cannot be done on the rows
  // a limited page happens to return.
  if (query.actor === "human") where.push("automated = false");
  if (query.actor === "auto") where.push("automated = true");
  // LIKE ANY over 'prefix%' patterns — the prefixes are our own literals, never user text, so the
  // only escaping question (a stray % in a prefix) cannot arise.
  if (query.actionPrefixes?.length) add("action LIKE ANY(?)", query.actionPrefixes.map((p) => `${p}%`));
  if (query.dataRuleId) add("data->>'ruleId' = ?", query.dataRuleId);
  if (query.dataExpirationSet) where.push("data->>'expiration' IS NOT NULL");
  if (query.q) { args.push(containsLike(query.q)); const p = `$${args.length}`; where.push(`(actor_name ILIKE ${p} OR action ILIKE ${p} OR summary ILIKE ${p} OR coalesce(target_name,'') ILIKE ${p})`); }
  return { where, args };
}

/** The game log's WHERE clause, shared by its listing and its count for the same reason the
 *  directory's is: a total that disagrees with the page it counts is worse than no total. */
function eventWhere(q: EventQuery): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  args.push(q.serverId); where.push(`server_id = $${args.length}`);
  if (q.kinds?.length) { args.push(q.kinds); where.push(`kind = ANY($${args.length}::text[])`); }
  if (q.playerId) { args.push(q.playerId); where.push(`(actor_player_id = $${args.length} OR victim_player_id = $${args.length})`); }
  if (q.from) { args.push(q.from); where.push(`ts >= $${args.length}`); }
  if (q.to) { args.push(q.to); where.push(`ts < $${args.length}`); }
  if (q.q?.trim()) {
    args.push(containsLike(q.q.trim()));
    const p = `$${args.length}`;
    // The message lives in the jsonb payload; ->> yields NULL for events that have none, and NULL
    // ILIKE is NULL, so those simply don't match rather than erroring.
    where.push(`(coalesce(actor_name,'') ILIKE ${p} OR coalesce(victim_name,'') ILIKE ${p} OR coalesce(data->>'message','') ILIKE ${p})`);
  }
  return { where, args };
}

/**
 * The directory's FROM/WHERE, built once and shared by the listing and its count so the two can
 * never disagree about what "matching" means.
 *
 * `serverId` changes the question the whole query asks. Scoped, it is "who plays on THIS server,
 * and what have they done here" — the stat columns and every sort built on them come from that
 * server's row alone. Unscoped, it is "everyone this community has ever seen", with careers summed
 * across servers. The directory used to only be able to ask the second one while the sidebar
 * displayed a specific server above it, so the numbers read as that server's and were not.
 */
/** The clan reads' scope as SQL on the players row `p` (an "AND …" clause, or ""), its values
 *  pushed onto `args`: one game's accounts, and players with a career row on the given servers. */
function clanScopeSql(s: ClanScope, args: unknown[]): string {
  const out: string[] = [];
  if (s.game) { args.push(s.game); out.push(`p.game = $${args.length}`); }
  if (s.serverIds) { args.push(s.serverIds); out.push(`EXISTS (SELECT 1 FROM player_stats x WHERE x.player_id = p.id AND x.server_id = ANY($${args.length}))`); }
  return out.length ? `AND ${out.join(" AND ")}` : "";
}

/** The directory's sorts that rank by career figures: every player's totals are needed before the
 *  first page can be told apart from the rest. */
const DIRECTORY_STAT_SORTS = new Set(["kills", "teamkills", "playtime", "visits"]);

function directoryFrom(f: PlayerDirectoryFilters): { join: string; where: string[]; args: unknown[]; vipSelect: string } {
  const args: unknown[] = [];
  const where: string[] = [];
  const scoped = f.serverIds !== undefined;
  // Pushed once and referenced by both the stats join and the VIP scope, so the listing and its
  // count bind exactly the same parameter list.
  const serverArg = scoped ? (args.push(f.serverIds), args.length) : 0;
  const vipSelect = vipExists(serverArg);
  const scope = scoped ? ` AND x.server_id = ANY($${serverArg})` : "";
  const totals = `sum(x.kills)::int AS kills, sum(x.deaths)::int AS deaths,
                     sum(x.teamkills)::int AS teamkills, sum(x.visits)::int AS visits,
                     sum(x.playtime_sec)::bigint AS playtime_sec`;
  // Sorted by when or who, a page needs only its own fifty players' totals: correlated, so they
  // are read per candidate player against the player_stats primary key, and the rest never are.
  // Sorted by a career figure, every player's totals decide the order, and reading them that way
  // was a hundred thousand separate reads (740ms on a 100k-player install): added up in one pass
  // and joined, it is about a fifth of that.
  const join = DIRECTORY_STAT_SORTS.has(f.sort ?? "")
    ? `LEFT JOIN (
              SELECT x.player_id, ${totals}
              FROM player_stats x
              WHERE true${scope}
              GROUP BY x.player_id
            ) s ON s.player_id = p.id`
    : `LEFT JOIN LATERAL (
              SELECT ${totals}
              FROM player_stats x
              WHERE x.player_id = p.id${scope}
            ) s ON true`;
  // Having a row for one of these servers IS having played there: the row is created by the first
  // connect (visits), the first kill, or the first roster sample the panel observed on it. Asked
  // as its own question rather than of the totals, so the count needs no totals at all.
  if (scoped) where.push(`EXISTS (SELECT 1 FROM player_stats sx WHERE sx.player_id = p.id AND sx.server_id = ANY($${serverArg}))`);
  const q = f.q?.trim();
  // Linked identities too, same reason as players.search: the number staff hold is often the
  // Steam64 / XUID from another surface, and it lives in external_links rather than on the row.
  if (q) { args.push(containsLike(q)); where.push(`(p.name ILIKE $${args.length} OR p.platform_id ILIKE $${args.length} OR EXISTS (SELECT 1 FROM external_links el WHERE el.player_id = p.id AND el.external_id ILIKE $${args.length}))`); }
  if (f.platform) {
    // A FAMILY id ("xbox", "msstore") matches every spelling the wire has used for it, with the
    // unreal enum prefix stripped; anything else filters by its exact stored token.
    const fam = platformFamilyTokens(f.platform);
    if (fam) { args.push(fam); where.push(`regexp_replace(lower(p.platform), '^eplatformfamily::', '') = ANY($${args.length})`); }
    else { args.push(f.platform); where.push(`p.platform = $${args.length}`); }
  }
  if (f.game) { args.push(f.game); where.push(`p.game = $${args.length}`); }
  if (f.seenFrom) { args.push(f.seenFrom); where.push(`p.last_seen >= $${args.length}`); }
  if (f.seenTill) { args.push(f.seenTill); where.push(`p.last_seen <= $${args.length}`); }
  if (f.watchedOnly) where.push("coalesce(f.watchlist, false)");
  if (f.vipOnly) where.push(vipSelect);
  // Has ever worn one of these spellings (player_aliases_clan_value_idx answers it).
  if (f.clanTags) { args.push(f.clanTags); where.push(`EXISTS (SELECT 1 FROM player_aliases ca WHERE ca.player_id = p.id AND ca.kind = 'clan' AND ca.value = ANY($${args.length}::text[]))`); }
  // Keyed on the game's platform id, like VIP grants — a ban is about the game identity, not our uuid.
  if (f.permaBannedOnly) where.push("EXISTS (SELECT 1 FROM player_ban pb WHERE pb.player_id = p.platform_id AND pb.kind = 'perma' AND pb.lifted_at IS NULL AND (pb.expires_at IS NULL OR pb.expires_at > now()))");
  return { join, where, args, vipSelect };
}

/**
 * "Is this player a VIP" — from the grants table, which is the book of record, scoped to the
 * chosen server when there is one.
 *
 * This used to read `player_flags.vip`, a manual marker a staffer can tick on a profile. The two
 * are unrelated: real VIP is granted per server with an expiry and is what the game is told about.
 * So the directory's ★ filter answered a different question from the ★ on the profile's VIP panel,
 * and could not answer it per server at all, because the flag has no server.
 *
 * Not a retired server's grant, for the same reason the profile leaves those out: the grant is
 * kept for the server's return, but it is not VIP the player has now.
 */
function vipExists(serverArg: number): string {
  // vips.player_id is the game's platform id, not our uuid. `serverArg` is the same bound
  // parameter the stats join uses, and it is a uuid ARRAY — a scope is a set of servers, not one.
  const scope = serverArg ? ` AND v.server_id = ANY($${serverArg})` : "";
  return `EXISTS (SELECT 1 FROM vips v
                   WHERE v.player_id = p.platform_id${scope}
                     AND (v.expiration IS NULL OR v.expiration > now())
                     AND NOT EXISTS (SELECT 1 FROM servers rs WHERE rs.id = v.server_id AND rs.retired_at IS NOT NULL))`;
}

/**
 * Postgres refuses a malformed uuid; the in-memory store just finds nothing.
 *
 * Every id column here is `uuid`, so `WHERE id = 'does-not-exist'` raises 22P02 rather than
 * matching no rows. Ids arrive from URLs, so a stale bookmark or a typo produced a 500 with a
 * database error in the log, where the same request against the memory store produced a clean 404
 * — which is why the whole test suite asserted the correct behaviour and passed while production
 * did the wrong thing.
 *
 * A value that cannot be a uuid cannot name a row, so for a READ the honest answer is "no rows".
 * That is applied here, once, around the pool: there are ~380 query sites and patching them
 * individually would be 380 chances to miss one, and the next one written would miss it too.
 *
 * Deliberately narrow:
 *  - only `invalid input syntax for type uuid` — not 22P02 generally, which also covers a bad
 *    integer or malformed json, where swallowing the error really would hide a bug;
 *  - only SELECTs — a write that names a nonexistent id must still fail loudly;
 *  - logged at warn, because our own code passing a non-uuid internally IS a bug and the signal
 *    should not disappear along with the 500.
 *
 * Not covered: queries issued on a client checked out via `pool.connect()` (the transactions).
 * Those are internal write paths reached after the entity has already been looked up through the
 * pool, so a bad id has been answered with a 404 before one of them is ever opened.
 */
function isBadUuidRead(err: unknown, sql: string): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "22P02"
    && typeof e.message === "string"
    && e.message.includes("type uuid")
    && /^\s*(?:WITH\b[\s\S]*?)?SELECT\b/i.test(sql);
}

/** The pool, with the rule above applied to every query that goes through it. */
function tolerantOfMalformedIds(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop !== "query") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (sql: unknown, args?: unknown) => {
        try {
          return await (target.query as (s: unknown, a?: unknown) => Promise<unknown>)(sql, args);
        } catch (err) {
          if (typeof sql === "string" && isBadUuidRead(err, sql)) {
            log.warn("a lookup was given something that is not an id — reading it as 'no such row'", {
              detail: (err as { message?: string }).message?.slice(0, 200),
            });
            return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
          }
          throw err;
        }
      };
    },
  });
}

/**
 * The newest DELIBERATE setting of each VIP's expiry on server $1 — what the VIP-drift report
 * compares a row against, and what its restore may give back. $2 narrows it to named players
 * (NULL = everyone).
 *
 * Not only staff grants. Every path that sets an expiry on purpose and records the value counts:
 * a grant (`vip.grant`), a group perk's release, a staff or rule cut (`vip.reduce`, whose value is
 * `after`), and a seed or game reward that actually granted VIP (one with an `expiration` — never
 * a dry run, never one a group perk held). Counting grants alone reported every seeder rewarded
 * since their last grant as "moved by an import", and a cut staff made as one to undo. A cut that
 * removed the VIP outright (`removed`) stops the row being judged at all: whatever wrote it since
 * left no record, and the newest deliberate act was "no VIP".
 *
 * Never the VIP reconciler's restores (`reconcile`): putting a VIP back on the game it had lost,
 * it records the grant row's CURRENT expiry, so counting that as a setting made whatever an import
 * had cut the value staff "set", and the cut vanished from the report the moment the reconciler
 * fixed the game list.
 */
const VIP_LAST_SET_CTE = `last_set AS (
  SELECT DISTINCT ON (a.target_id)
         a.target_id AS player_id,
         CASE WHEN a.action = 'vip.reduce' THEN a.data->>'after' ELSE a.data->>'expiration' END AS granted,
         (a.action = 'vip.reduce' AND COALESCE(a.data->>'removed', '') = 'true') AS removed,
         a.ts AS granted_at, a.actor_name AS granted_by
    FROM audit a
   WHERE a.server_id = $1 AND a.target_id IS NOT NULL
     AND ($2::text[] IS NULL OR a.target_id = ANY($2::text[]))
     AND COALESCE(a.data->>'groupHeld', '') <> 'true'
     AND COALESCE(a.data->>'dryRun', '') <> 'true'
     AND COALESCE(a.data->>'reconcile', '') <> 'true'
     AND (a.action IN ('vip.grant', 'vip.group_release', 'vip.reduce')
          OR (a.action IN ('seed.reward', 'game.reward') AND a.data ? 'expiration'))
   ORDER BY a.target_id, a.ts DESC
)`;

export class PostgresRepository implements Repository {
  private readonly pool: Pool;
  private readonly auditWatchers = new Set<(row: AuditRow) => void>();

  constructor(pool: Pool) {
    this.pool = tolerantOfMalformedIds(pool);
  }

  /** Drain and close the connection pool. See `Repository.close` — a live pool holds the event
   *  loop open, which is indistinguishable from a hang in a test runner. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Apply pending migrations. Safe to call repeatedly AND concurrently: the api and worker
   * containers start together and both migrate, but `CREATE TABLE IF NOT EXISTS` is not
   * atomic under concurrency in Postgres (racing creators collide on pg_type). A session-level
   * advisory lock serializes migrations across processes — the second waits, then finds every
   * migration already applied and does nothing.
   *
   * The lock wait is bounded and self-healing. A blocking pg_advisory_lock would hang forever
   * if a previous holder's container was killed without closing its TCP connection (Postgres
   * keeps the dead session — and the lock — until keepalives notice, which can be hours).
   * Instead we poll with pg_try_advisory_lock; a holder that has gone quiet for staleMs while
   * idle is presumed dead and terminated (its transaction rolls back, so this is safe), while
   * an actively-working holder is waited on. If the lock still can't be had after maxWaitMs,
   * fail loudly so the supervisor restarts us — a visible crash, never a silent hang.
   */
  async migrate(): Promise<void> {
    const { pollMs, staleMs, maxWaitMs } = lockTuning();
    const client = await this.pool.connect();
    let locked = false;
    try {
      const started = Date.now();
      let warned = false;
      for (;;) {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [MIGRATION_LOCK_KEY]);
        if (rows[0].ok) {
          locked = true;
          break;
        }
        // Single-argument advisory locks store the key's high 32 bits in classid (0 for our
        // small key) and the low 32 bits in objid.
        const { rows: holders } = await client.query(
          `SELECT a.pid, a.state, extract(epoch FROM (now() - a.state_change)) AS quiet_s
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 0 AND l.objid = $1`,
          [MIGRATION_LOCK_KEY],
        );
        const holder = holders[0];
        const quietMs = holder ? Number(holder.quiet_s) * 1000 : 0;
        if (holder && (holder.state === "idle" || holder.state === "idle in transaction") && quietMs > staleMs) {
          // Idle while holding the migration lock is not a state our code can be in for long —
          // a live migrator is either running a statement or done (and unlocked). Reclaim.
          log.warn("migration lock held by a dead session — terminating it", { pid: holder.pid, state: holder.state, quietSeconds: Math.round(quietMs / 1000) });
          await client.query("SELECT pg_terminate_backend($1)", [holder.pid]);
          continue;
        }
        if (!warned && Date.now() - started > 15_000) {
          warned = true;
          log.warn("still waiting for the migration lock", { holderPid: holder?.pid ?? null, holderState: holder?.state ?? null });
        }
        if (Date.now() - started > maxWaitMs) {
          throw new Error(`timed out waiting for the migration advisory lock (holder pid ${holder?.pid ?? "unknown"}, state ${holder?.state ?? "unknown"}) — another process appears stuck mid-migration`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      // A database whose applied migrations include ids this build doesn't know was created by a
      // different lineage — in practice the pre-release chain that was squashed for release.
      // Refuse loudly: running the guarded baseline over that schema would half-apply and diverge
      // silently, which is far worse than an error telling the operator to start fresh.
      const known = new Set(MIGRATIONS.map((m) => m.id));
      const { rows: appliedRows } = await client.query("SELECT id FROM schema_migrations ORDER BY id");
      const appliedIds = new Set(appliedRows.map((r: { id: string }) => r.id));
      {
        const foreign = [...appliedIds].filter((id) => !known.has(id));
        if (foreign.length > 0) {
          throw new Error(
            `this database was created by a different migration lineage (${foreign.length} unknown migration(s), first: "${foreign[0]}"). ` +
            `The pre-release migration chain was squashed for release — start from a fresh database.`,
          );
        }
      }
      // Skipped from the set read above — this loop used to ask the database "is this applied?"
      // once per migration, ~70 sequential round trips on EVERY boot of the api and the worker,
      // to re-discover a list it had already fetched whole for the lineage check two lines up.
      // Safe because the advisory lock is held for the whole pass: nobody else can be applying.
      for (const m of MIGRATIONS) {
        if (appliedIds.has(m.id)) continue;
        try {
          await client.query("BEGIN");
          await client.query(m.sql);
          await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    } finally {
      // Release on the same connection that took it, then return it to the pool.
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  users = {
    create: async (input: { username: string; passwordHash?: string | null; email?: string | null; discordId?: string | null; discordUsername?: string | null; discordNick?: string | null; discordManaged?: boolean }): Promise<UserRow> => {
      const id = randomUUID();
      const { rows } = await this.pool.query(
        "INSERT INTO users (id, username, password_hash, email, discord_id, discord_username, discord_nick, discord_managed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [id, input.username, input.passwordHash ?? null, input.email ?? null, input.discordId ?? null, input.discordUsername ?? null, input.discordNick ?? null, input.discordManaged ?? false],
      );
      return toUser(rows[0]);
    },
    findById: async (id: string) => {
      const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    findByUsername: async (username: string) => {
      const { rows } = await this.pool.query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    findByDiscordId: async (discordId: string) => {
      const { rows } = await this.pool.query("SELECT * FROM users WHERE discord_id = $1", [discordId]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    firstUserId: async () => {
      // Earliest created_at, id as the tie-break: same second is possible, same answer is required.
      const { rows } = await this.pool.query("SELECT id FROM users ORDER BY created_at, id LIMIT 1");
      return rows[0] ? (rows[0].id as string) : null;
    },
    count: async () => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM users");
      return rows[0].n as number;
    },
    list: async () => {
      const { rows } = await this.pool.query("SELECT * FROM users ORDER BY username");
      return rows.map(toUser);
    },
    listDiscordLinked: async () => {
      const { rows } = await this.pool.query("SELECT * FROM users WHERE discord_id IS NOT NULL");
      return rows.map(toUser);
    },
    linkDiscord: async (id: string, input: { discordId: string; username?: string | null; nick?: string | null; managed?: boolean }) => {
      // COALESCE on the $n IS NULL guard: passing undefined leaves that column untouched, so a
      // partial refresh (e.g. the sweep only knowing the nick) never blanks the other name.
      const { rows } = await this.pool.query(
        `UPDATE users SET discord_id = $2,
           discord_username = CASE WHEN $3::boolean THEN $4 ELSE discord_username END,
           discord_nick     = CASE WHEN $5::boolean THEN $6 ELSE discord_nick END,
           discord_managed  = CASE WHEN $7::boolean THEN $8 ELSE discord_managed END
         WHERE id = $1 RETURNING *`,
        [id, input.discordId,
         input.username !== undefined, input.username ?? null,
         input.nick !== undefined, input.nick ?? null,
         input.managed !== undefined, input.managed ?? false],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },
    setAnnouncementsSeen: async (id: string): Promise<void> => {
      await this.pool.query("UPDATE users SET announcements_seen_at = now() WHERE id = $1", [id]);
    },
    getPrefs: async (id: string): Promise<Record<string, unknown>> => {
      const { rows } = await this.pool.query("SELECT prefs FROM users WHERE id = $1", [id]);
      return (rows[0]?.prefs ?? {}) as Record<string, unknown>;
    },
    setPrefs: async (id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
      // Merged in SQL rather than read-modify-write: two tabs saving different settings at the
      // same moment would otherwise each write a whole blob and the slower one would erase the
      // other's change.
      const { rows } = await this.pool.query(
        "UPDATE users SET prefs = COALESCE(prefs, '{}'::jsonb) || $2::jsonb WHERE id = $1 RETURNING prefs",
        [id, JSON.stringify(patch)],
      );
      return (rows[0]?.prefs ?? {}) as Record<string, unknown>;
    },
    setDiscordManaged: async (id: string, managed: boolean) => {
      const { rows } = await this.pool.query("UPDATE users SET discord_managed = $2 WHERE id = $1 RETURNING *", [id, managed]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    revokeSessions: async (id: string): Promise<number | null> => {
      // The bump and the read are one statement: two callers locking the same account out at the
      // same moment must not both read the same "next" value and leave one of them un-applied.
      const { rows } = await this.pool.query(
        "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch", [id]);
      return rows[0] ? Number(rows[0].session_epoch) : null;
    },
    remove: async (id: string) => {
      const { rowCount } = await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
    setPassword: async (id: string, passwordHash: string) => {
      const { rowCount } = await this.pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
      return (rowCount ?? 0) > 0;
    },
    merge: async (survivorId: string, duplicateId: string) => {
      if (survivorId === duplicateId) return null;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const [{ rows: sRows }, { rows: dRows }] = await Promise.all([
          client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [survivorId]),
          client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [duplicateId]),
        ]);
        if (!sRows[0] || !dRows[0]) { await client.query("ROLLBACK"); return null; }
        const survivor = toUser(sRows[0]);
        const dup = toUser(dRows[0]);
        // History moves: everything keyed by the duplicate's user id now points at the survivor.
        await client.query("UPDATE audit SET actor_user_id = $1 WHERE actor_user_id = $2", [survivorId, duplicateId]);
        await client.query("UPDATE audit SET target_id = $1 WHERE target_type = 'user' AND target_id = $2", [survivorId, duplicateId]);
        await client.query("UPDATE player_notes SET author_user_id = $1 WHERE author_user_id = $2", [survivorId, duplicateId]);
        await client.query("UPDATE announcements SET author_user_id = $1 WHERE author_user_id = $2", [survivorId, duplicateId]);
        // Read receipts: keep the EARLIEST read/ack when both accounts saw the same notice
        // (LEAST/GREATEST skip nulls, so an ack on either side survives).
        await client.query(
          `INSERT INTO announcement_reads (announcement_id, user_id, read_at, acknowledged_at)
           SELECT announcement_id, $1, read_at, acknowledged_at FROM announcement_reads WHERE user_id = $2
           ON CONFLICT (announcement_id, user_id) DO UPDATE SET
             read_at = LEAST(announcement_reads.read_at, EXCLUDED.read_at),
             acknowledged_at = LEAST(announcement_reads.acknowledged_at, EXCLUDED.acknowledged_at)`,
          [survivorId, duplicateId],
        );
        // The duplicate's tokens/grants/roles/limits/reads die with the row (ON DELETE CASCADE) —
        // the survivor's own access is the one that counts. Delete BEFORE transferring the Discord
        // identity so the unique discord_id index never sees it twice.
        await client.query("DELETE FROM users WHERE id = $1", [duplicateId]);
        if (!survivor.discordId && dup.discordId) {
          await client.query(
            "UPDATE users SET discord_id = $2, discord_username = $3, discord_nick = $4, discord_managed = $5 WHERE id = $1",
            [survivorId, dup.discordId, dup.discordUsername, dup.discordNick, dup.discordManaged],
          );
        }
        await client.query("UPDATE users SET announcements_seen_at = GREATEST(announcements_seen_at, $2) WHERE id = $1", [survivorId, dup.announcementsSeenAt]);
        const { rows } = await client.query("SELECT * FROM users WHERE id = $1", [survivorId]);
        await client.query("COMMIT");
        return rows[0] ? toUser(rows[0]) : null;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };

  discordRoleMap = {
    list: async (): Promise<DiscordRoleMapRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM discord_role_map ORDER BY coalesce(discord_role_name, discord_role_id)");
      return rows.map(toDiscordRoleMap);
    },
    setForDiscordRole: async (discordRoleId: string, discordRoleName: string | null, assignments: RoleAssignment[]): Promise<void> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM discord_role_map WHERE discord_role_id = $1", [discordRoleId]);
        for (const a of assignments) {
          // The conflict target has to name the same expression as the unique index, since the
          // null-as-global scope is folded there rather than stored as NULL in the key.
          await client.query(
            `INSERT INTO discord_role_map (discord_role_id, discord_role_name, role_id, scope_id) VALUES ($1,$2,$3,$4)
             ON CONFLICT (discord_role_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
             DO UPDATE SET discord_role_name = EXCLUDED.discord_role_name`,
            [discordRoleId, discordRoleName, a.roleId, a.scopeId],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    remove: async (discordRoleId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM discord_role_map WHERE discord_role_id = $1", [discordRoleId]);
      return (rowCount ?? 0) > 0;
    },
  };

  tokens = {
    create: async (input: { userId: string; name: string; tokenHash: string; expiresAt?: string | null }): Promise<ApiTokenRow> => {
      const id = randomUUID();
      const { rows } = await this.pool.query(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [id, input.userId, input.name, input.tokenHash, input.expiresAt ?? null],
      );
      return toToken(rows[0]);
    },
    findByHash: async (tokenHash: string) => {
      const { rows } = await this.pool.query("SELECT * FROM api_tokens WHERE token_hash = $1", [tokenHash]);
      return rows[0] ? toToken(rows[0]) : null;
    },
    listByUser: async (userId: string): Promise<ApiTokenRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
      return rows.map(toToken);
    },
    remove: async (id: string, userId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM api_tokens WHERE id = $1 AND user_id = $2", [id, userId]);
      return (rowCount ?? 0) > 0;
    },
    removeAllForUser: async (userId: string): Promise<number> => {
      const { rowCount } = await this.pool.query("DELETE FROM api_tokens WHERE user_id = $1", [userId]);
      return rowCount ?? 0;
    },
  };

  pushSubscriptions = {
    list: async (): Promise<PushSubscriptionRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM push_subscriptions ORDER BY created_at");
      return rows.map(toPushSubscription);
    },
    listByUser: async (userId: string): Promise<PushSubscriptionRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at", [userId]);
      return rows.map(toPushSubscription);
    },
    get: async (endpoint: string): Promise<PushSubscriptionRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
      return rows[0] ? toPushSubscription(rows[0]) : null;
    },
    upsert: async (row: Omit<PushSubscriptionRow, "createdAt">): Promise<PushSubscriptionRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, device, origin, epoch) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           device = EXCLUDED.device, origin = EXCLUDED.origin, epoch = EXCLUDED.epoch
         RETURNING *`,
        [row.endpoint, row.userId, row.p256dh, row.auth, row.device, row.origin, row.epoch],
      );
      return toPushSubscription(rows[0]);
    },
    remove: async (endpoint: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
      return (rowCount ?? 0) > 0;
    },
  };

  servers = {
    create: async (input: NewServer): Promise<ServerRow> => {
      const id = randomUUID();
      const { rows } = await this.pool.query(
        `INSERT INTO servers (id, name, game, protocol, host, port, password, engagement_mode, header_mode, crcon_base_url, automation, seed_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
        [id, input.name, input.game ?? "hll", input.protocol ?? "binary-v2", input.host, input.port, encryptionKey() ? sealSecret(input.password, encryptionKey()) : input.password, input.engagementMode ?? "observe", input.headerMode ?? "magic", input.crconBaseUrl ?? null, JSON.stringify(input.automation ?? {}), input.seedSlot ?? null],
      );
      return toServer(rows[0]);
    },
    findById: async (id: string) => {
      const { rows } = await this.pool.query("SELECT * FROM servers WHERE id = $1", [id]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    findByHostPort: async (host: string, port: number) => {
      const { rows } = await this.pool.query("SELECT * FROM servers WHERE host = $1 AND port = $2 LIMIT 1", [host, port]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    findBySeedSlot: async (slot: number) => {
      const { rows } = await this.pool.query("SELECT * FROM servers WHERE seed_slot = $1", [slot]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    claimSeedSlot: async (id: string, slot: number) => {
      // Never steals a slot another server already holds — the WHERE clause makes the claim a
      // no-op in that case rather than an error, so a confused env cannot detach a live server
      // from its history on the way past.
      const { rows } = await this.pool.query(
        `UPDATE servers SET seed_slot = $2 WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM servers other WHERE other.seed_slot = $2 AND other.id <> $1)
         RETURNING *`,
        [id, slot],
      );
      return rows[0] ? toServer(rows[0]) : null;
    },
    list: async (opts?: { includeRetired?: boolean }) => {
      const { rows } = await this.pool.query(
        opts?.includeRetired ? "SELECT * FROM servers ORDER BY created_at"
          : "SELECT * FROM servers WHERE retired_at IS NULL ORDER BY created_at");
      return rows.map(toServer);
    },
    setRetired: async (id: string, retired: boolean): Promise<ServerRow | null> => {
      const { rows } = await this.pool.query(
        "UPDATE servers SET retired_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1 RETURNING *", [id, retired]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    setDecommissioned: async (id: string, decommissioned: boolean): Promise<ServerRow | null> => {
      const { rows } = await this.pool.query(
        "UPDATE servers SET decommissioned_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1 RETURNING *", [id, decommissioned]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      // One row; the schema's ON DELETE CASCADE does the fan-out. See the interface doc — the
      // caller runs purgeServerData first for the no-FK history tables.
      //
      // The leftover objective-preset row is the exception: no FK on purpose (a data-port restore's
      // DELETE FROM servers must not cascade away a put-back still owed), so it goes here, by hand.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { rowCount } = await client.query("DELETE FROM servers WHERE id = $1", [id]);
        const gone = (rowCount ?? 0) > 0;
        if (gone) {
          await client.query("DELETE FROM map_point_pending WHERE server_id = $1", [id]);
        }
        await client.query("COMMIT");
        return gone;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    setEngagementMode: async (id: string, mode: EngagementMode) => {
      const { rows } = await this.pool.query("UPDATE servers SET engagement_mode = $2 WHERE id = $1 RETURNING *", [id, mode]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    updateConnection: async (id: string, patch: ServerConnectionPatch) => {
      const sets: string[] = [];
      const args: unknown[] = [id];
      const put = (col: string, value: unknown) => { args.push(value); sets.push(`${col} = $${args.length}`); };
      if (patch.host !== undefined) put("host", patch.host);
      if (patch.port !== undefined) put("port", patch.port);
      // Sealed the same way `create` seals it, so a rotated secret is stored no differently from
      // the original one and `openSecret` on the read path stays oblivious to which it got.
      if (patch.password !== undefined) put("password", encryptionKey() ? sealSecret(patch.password, encryptionKey()!) : patch.password);
      if (patch.protocol !== undefined) put("protocol", patch.protocol);
      if (patch.headerMode !== undefined) put("header_mode", patch.headerMode);
      if (patch.crconBaseUrl !== undefined) put("crcon_base_url", patch.crconBaseUrl);
      if (!sets.length) return this.servers.findById(id);
      const { rows } = await this.pool.query(`UPDATE servers SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, args);
      return rows[0] ? toServer(rows[0]) : null;
    },
    recordContact: async (id: string, outcome: { ok: true } | { ok: false; error: string }) => {
      if (outcome.ok) {
        // Throttled in SQL rather than in memory, so every process (api, worker, each runner)
        // shares one decision instead of each keeping its own idea of "recently".
        await this.pool.query(
          `UPDATE servers SET last_contact_at = now(), last_error = NULL, last_error_at = NULL
             WHERE id = $1 AND (last_error IS NOT NULL OR last_contact_at IS NULL OR last_contact_at < now() - interval '1 minute')`,
          [id],
        );
        return;
      }
      // Bounded: an upstream error can carry a whole stack, and this column is read by a UI.
      await this.pool.query("UPDATE servers SET last_error = $2, last_error_at = now() WHERE id = $1", [id, outcome.error.slice(0, 500)]);
    },
    setStreamerMode: async (id: string, on: boolean) => {
      const { rows } = await this.pool.query("UPDATE servers SET streamer_mode = $2 WHERE id = $1 RETURNING *", [id, on]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    setPublicProfile: async (id: string, profile: { publicSlug: string | null; publicName: string | null; publicPlayerIds: boolean }) => {
      // A taken slug throws here (the UNIQUE constraint) — the route turns it into a 409.
      const { rows } = await this.pool.query(
        "UPDATE servers SET public_slug = $2, public_name = $3, public_player_ids = $4 WHERE id = $1 RETURNING *",
        [id, profile.publicSlug, profile.publicName, profile.publicPlayerIds],
      );
      return rows[0] ? toServer(rows[0]) : null;
    },
    setNickname: async (id: string, nickname: string | null) => {
      const { rows } = await this.pool.query("UPDATE servers SET nickname = $2 WHERE id = $1 RETURNING *", [id, nickname]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    findBySlug: async (publicSlug: string) => {
      // Retired servers do not answer their public address: the slug lookup is the anonymous
      // surface's ONLY way in, so refusing here is what "everything external gets paused" means.
      const { rows } = await this.pool.query("SELECT * FROM servers WHERE public_slug = $1 AND retired_at IS NULL", [publicSlug]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    setAutomation: async (id: string, automation: ServerRow["automation"]): Promise<ServerRow | null> => {
      const { rows } = await this.pool.query("UPDATE servers SET automation = $2::jsonb WHERE id = $1 RETURNING *", [id, JSON.stringify(automation ?? {})]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    updateName: async (id: string, name: string) => {
      const { rows } = await this.pool.query("UPDATE servers SET name = $2 WHERE id = $1 RETURNING *", [id, name]);
      return rows[0] ? toServer(rows[0]) : null;
    },
    setGame: async (id: string, game: string, protocol: RconProtocol) => {
      const { rows } = await this.pool.query(
        "UPDATE servers SET game = $2, protocol = $3 WHERE id = $1 RETURNING *",
        [id, game, protocol],
      );
      return rows[0] ? toServer(rows[0]) : null;
    },
  };

  grants = {
    userIdsWithGlobalCapability: async (capability: string, level: AccessLevel): Promise<string[]> => {
      // "At `level` or above", as the set of levels that pass — the memory store compares ranks.
      const levels: AccessLevel[] = ["none", "read", "write"];
      const atLeast = levels.slice(levels.indexOf(level));
      const { rows } = await this.pool.query(
        "SELECT DISTINCT user_id FROM grants WHERE capability = $1 AND scope_type = $2 AND level = ANY($3::text[])",
        [capability, "global", atLeast],
      );
      return rows.map((r) => r.user_id as string);
    },
    listByUser: async (userId: string) => {
      const { rows } = await this.pool.query("SELECT * FROM grants WHERE user_id = $1", [userId]);
      return rows.map(toGrant);
    },
    create: async (input: Omit<GrantRow, "id">): Promise<GrantRow> => {
      const id = randomUUID();
      const { rows } = await this.pool.query(
        "INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [id, input.userId, input.capability, input.scopeType, input.scopeId, input.level],
      );
      return toGrant(rows[0]);
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM grants WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  userLimits = {
    get: async (userId: string) => {
      const { rows } = await this.pool.query("SELECT key, value FROM user_limits WHERE user_id = $1", [userId]);
      const out: Record<string, number> = {};
      for (const r of rows) out[r.key as string] = Number(r.value);
      return out;
    },
    replace: async (userId: string, limits: Record<string, number>) => {
      await this.pool.query("DELETE FROM user_limits WHERE user_id = $1", [userId]);
      for (const [key, value] of Object.entries(limits)) {
        await this.pool.query("INSERT INTO user_limits (user_id, key, value) VALUES ($1,$2,$3)", [userId, key, value]);
      }
    },
  };

  roles = {
    list: async () => {
      const { rows } = await this.pool.query("SELECT * FROM roles ORDER BY name");
      return rows.map(toRole);
    },
    get: async (id: string) => {
      const { rows } = await this.pool.query("SELECT * FROM roles WHERE id = $1", [id]);
      return rows[0] ? toRole(rows[0]) : null;
    },
    getMany: async (ids: string[]): Promise<RoleRow[]> => {
      const want = [...new Set(ids.filter(Boolean))];
      if (!want.length) return [];
      const { rows } = await this.pool.query("SELECT * FROM roles WHERE id = ANY($1::uuid[])", [want]);
      return rows.map(toRole);
    },
    findByName: async (name: string) => {
      const { rows } = await this.pool.query("SELECT * FROM roles WHERE lower(name) = lower($1)", [name]);
      return rows[0] ? toRole(rows[0]) : null;
    },
    create: async (input: NewRole): Promise<RoleRow> => {
      // `limits ?? {}` and `grants ?? []`: the memory store spreads these, so an absent one becomes
      // an empty collection there, while `JSON.stringify(undefined)` is undefined — a NULL into a
      // NOT NULL column. A role with no rate limits is an ordinary role, and the two stores have to
      // agree about that, or the same call succeeds in tests and fails in production.
      const { rows } = await this.pool.query(
        "INSERT INTO roles (id, name, description, grants, limits, created_by_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [randomUUID(), input.name, input.description ?? null, JSON.stringify(input.grants ?? []), JSON.stringify(input.limits ?? {}), input.createdByName ?? null],
      );
      return toRole(rows[0]);
    },
    update: async (id: string, patch: Partial<Omit<NewRole, "createdByName">>): Promise<RoleRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE roles SET
           name = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           grants = COALESCE($5::jsonb, grants),
           limits = COALESCE($6::jsonb, limits),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.description !== undefined,
          patch.description ?? null,
          patch.grants !== undefined ? JSON.stringify(patch.grants) : null,
          patch.limits !== undefined ? JSON.stringify(patch.limits) : null,
        ],
      );
      return rows[0] ? toRole(rows[0]) : null;
    },
    remove: async (id: string) => {
      const { rowCount } = await this.pool.query("DELETE FROM roles WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  userRoles = {
    listByUser: async (userId: string): Promise<RoleAssignment[]> => {
      const { rows } = await this.pool.query("SELECT role_id, scope_id FROM user_roles WHERE user_id = $1", [userId]);
      return rows.map((r) => ({ roleId: r.role_id as string, scopeId: (r.scope_id as string | null) ?? null }));
    },
    listByUsers: async (userIds: string[]): Promise<Map<string, RoleAssignment[]>> => {
      const out = new Map<string, RoleAssignment[]>();
      const ids = [...new Set(userIds.filter(Boolean))];
      if (!ids.length) return out;
      const { rows } = await this.pool.query("SELECT user_id, role_id, scope_id FROM user_roles WHERE user_id = ANY($1::uuid[])", [ids]);
      for (const r of rows) {
        const list = out.get(r.user_id as string) ?? [];
        list.push({ roleId: r.role_id as string, scopeId: (r.scope_id as string | null) ?? null });
        out.set(r.user_id as string, list);
      }
      return out;
    },
    // Membership is "holds this role at all" — the roles view counts people, and someone scoped to
    // one server is still a member.
    members: async (roleId: string) => {
      const { rows } = await this.pool.query("SELECT DISTINCT user_id FROM user_roles WHERE role_id = $1", [roleId]);
      return rows.map((r) => r.user_id as string);
    },
    unscopedMembersOf: async (roleIds: string[]): Promise<string[]> => {
      const ids = [...new Set(roleIds.filter(Boolean))];
      if (!ids.length) return [];
      const { rows } = await this.pool.query(
        "SELECT DISTINCT user_id FROM user_roles WHERE role_id = ANY($1::uuid[]) AND scope_id IS NULL",
        [ids],
      );
      return rows.map((r) => r.user_id as string);
    },
    set: async (userId: string, assignments: RoleAssignment[]) => {
      await this.pool.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
      for (const a of assignments) {
        await this.pool.query("INSERT INTO user_roles (user_id, role_id, scope_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [userId, a.roleId, a.scopeId]);
      }
    },
  };

  /** Upsert a name/clan-tag sighting into player_aliases (stamp first_seen once, bump last_seen). */
  private async recordAlias(playerId: string, kind: "name" | "clan", value: string, ts: string): Promise<void> {
    const v = value.trim();
    if (!v) return;
    await this.pool.query(
      `INSERT INTO player_aliases (player_id, kind, value, first_seen, last_seen, seen_count)
       VALUES ($1,$2,$3,$4,$4,1)
       ON CONFLICT (player_id, kind, value) DO UPDATE SET
         last_seen = GREATEST(player_aliases.last_seen, EXCLUDED.last_seen),
         first_seen = LEAST(player_aliases.first_seen, EXCLUDED.first_seen),
         seen_count = player_aliases.seen_count + 1`,
      [playerId, kind, v, ts],
    );
  }

  players = {
    upsert: async (input: SeenPlayer): Promise<PlayerRow> => {
      const id = randomUUID();
      const ts = input.ts ?? new Date().toISOString();
      // Identity is platform_id ALONE (migration 041): the roster reports the game's platform
      // string while ingest infers one, and keying on both forked players into twin rows. The
      // platform column is display metadata — a real platform overwrites an inferred placeholder,
      // never the other way around. first_seen/last_seen are the OUTERMOST sightings whatever
      // order they arrive in: a historical import may hand this a timestamp years older than the
      // row (LEAST backdates first_seen), and live traffic only ever pushes last_seen forward.
      const { rows } = await this.pool.query(
        `INSERT INTO players (id, game, platform, platform_id, name, first_seen, last_seen, level)
         VALUES ($1,$6,$2,$3,$4,$5,$5,$7::int)
         -- The game column is deliberately absent from the DO UPDATE list below: an account belongs
         -- to the game whose server first reported it and cannot move to another.
         ON CONFLICT (platform_id)
         DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE players.name END,
                       last_seen = GREATEST(players.last_seen, EXCLUDED.last_seen),
                       first_seen = LEAST(players.first_seen, EXCLUDED.first_seen),
                       platform = CASE WHEN players.platform IN ('other','unknown') AND EXCLUDED.platform NOT IN ('other','unknown')
                                       THEN EXCLUDED.platform ELSE players.platform END,
                       level = COALESCE(EXCLUDED.level, players.level)
         RETURNING *`,
        [id, input.platform, input.platformId, input.name, ts, input.game, input.level ?? null],
      );
      const player = toPlayer(rows[0]);
      await this.recordAlias(player.id, "name", input.name, ts);
      if (input.clanTag !== undefined) await this.recordAlias(player.id, "clan", input.clanTag, ts);
      return player;
    },
    upsertMany: async (inputs: SeenPlayer[]): Promise<PlayerRow[]> => {
      // Two different dedupes, because the player row and its alias history answer different
      // questions. ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so both
      // lists have to be unique — but a roster that lists someone twice under two names should
      // still record BOTH names, exactly as the per-player loop did.
      const seen = inputs
        .map((i) => ({ ...i, platformId: String(i.platformId ?? "").trim() }))
        .filter((i) => i.platformId);
      // Player rows: one per platform id, last write wins (that is the freshest read of them).
      // Sorted by platform id so every concurrent batch (two servers share players) locks rows in
      // the same order — unsorted batches deadlocked against each other in production.
      const byPlatform = new Map<string, SeenPlayer>();
      for (const i of seen) byPlatform.set(i.platformId, i);
      const list = [...byPlatform.values()].sort((a, b) => a.platformId < b.platformId ? -1 : 1);
      if (!list.length) return [];

      const vals: unknown[] = [];
      const tuples = list.map((i, n) => {
        vals.push(randomUUID(), i.platform, i.platformId, i.name, i.ts ?? new Date().toISOString(), i.game, i.level ?? null);
        const b = n * 7;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::timestamptz,$${b + 6},$${b + 7}::int)`;
      });
      // Identical conflict rules to the single upsert above — see its note on migration 041, and on
      // why `game` is set once and never updated.
      const { rows } = await this.pool.query(
        `INSERT INTO players (id, platform, platform_id, name, first_seen, last_seen, game, level)
         SELECT id::uuid, platform, platform_id, name, ts, ts, game, level FROM (VALUES ${tuples.join(",")}) AS v(id, platform, platform_id, name, ts, game, level)
         ON CONFLICT (platform_id)
         DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE players.name END,
                       last_seen = GREATEST(players.last_seen, EXCLUDED.last_seen),
                       first_seen = LEAST(players.first_seen, EXCLUDED.first_seen),
                       platform = CASE WHEN players.platform IN ('other','unknown') AND EXCLUDED.platform NOT IN ('other','unknown')
                                       THEN EXCLUDED.platform ELSE players.platform END,
                       -- A sighting that could not read the level is not evidence they have none.
                       level = COALESCE(EXCLUDED.level, players.level)
         RETURNING *`, vals);

      const players = rows.map(toPlayer);
      const idByPlatform = new Map(players.map((p) => [p.platformId, p.id]));
      // Alias rows: every DISTINCT value in the batch, one statement per kind. A name repeated
      // within one read is one sighting, so its seen_count moves by one — which is what a single
      // roster read actually witnessed.
      for (const kind of ["name", "clan"] as const) {
        const entries = new Map<string, { pid: string; value: string; ts: string }>();
        for (const i of seen) {
          const value = (kind === "name" ? i.name : i.clanTag)?.trim();
          const pid = idByPlatform.get(i.platformId);
          if (!value || !pid) continue;
          entries.set(`${pid}\u0000${value}`, { pid, value, ts: i.ts ?? new Date().toISOString() });
        }
        // Sorted for consistent lock order across concurrent flushes (deadlock prevention).
        const args: unknown[] = [];
        const rowsSql = [...entries.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, e], n) => {
          args.push(e.pid, kind, e.value, e.ts);
          const b = n * 4;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::timestamptz)`;
        });
        if (!rowsSql.length) continue;
        await this.pool.query(
          `INSERT INTO player_aliases (player_id, kind, value, first_seen, last_seen, seen_count)
           SELECT player_id::uuid, kind, value, ts, ts, 1 FROM (VALUES ${rowsSql.join(",")}) AS v(player_id, kind, value, ts)
           ON CONFLICT (player_id, kind, value) DO UPDATE SET
             last_seen = GREATEST(player_aliases.last_seen, EXCLUDED.last_seen),
             first_seen = LEAST(player_aliases.first_seen, EXCLUDED.first_seen),
             seen_count = player_aliases.seen_count + 1`, args);
      }
      return players;
    },
    lastSeenDrift: async (limit = 20): Promise<LastSeenDrift> => {
      // The same evidence expression the repair applies, read instead of written, with each source
      // kept separate so the panel can say WHY a clock is wrong rather than only that it is.
      const { rows } = await this.pool.query(
        `SELECT p.id, p.name, p.platform_id, p.last_seen, p.first_seen, ev.session_end, ev.event_ts,
                GREATEST(p.first_seen, COALESCE(ev.session_end, p.first_seen), COALESCE(ev.event_ts, p.first_seen)) AS best,
                count(*) OVER () AS total
           FROM players p
           CROSS JOIN LATERAL (
             SELECT (SELECT max(s.disconnected_at) FROM player_sessions s WHERE s.player_id = p.id) AS session_end,
                    GREATEST((SELECT max(e.ts) FROM evt e WHERE e.actor_player_id = p.id),
                             (SELECT max(e.ts) FROM evt e WHERE e.victim_player_id = p.id)) AS event_ts
           ) ev
          WHERE p.last_seen > GREATEST(p.first_seen, COALESCE(ev.session_end, p.first_seen), COALESCE(ev.event_ts, p.first_seen))
          ORDER BY p.last_seen - GREATEST(p.first_seen, COALESCE(ev.session_end, p.first_seen), COALESCE(ev.event_ts, p.first_seen)) DESC
          LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        sample: rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          platformId: r.platform_id as string,
          lastSeen: new Date(r.last_seen).toISOString(),
          best: new Date(r.best).toISOString(),
          firstSeen: new Date(r.first_seen).toISOString(),
          lastSessionEnd: r.session_end ? new Date(r.session_end).toISOString() : null,
          lastEvent: r.event_ts ? new Date(r.event_ts).toISOString() : null,
        })),
      };
    },
    settleLastSeenFromEvidence: async (): Promise<number> => {
      // GREATEST over the evidence trail, one correlated probe per source so each rides its own
      // index (sessions by player, evt by actor, evt by victim). Only ever LOWERS a row, and only
      // when the stored value postdates everything — so a legitimate roster-capture bump on a
      // player online right now is re-raised by the next snapshot within a minute.
      //
      // Done in windows, and locking each window in platform_id order, because this used to be one
      // whole-table UPDATE and it deadlocked against live ingest. Every batched upsert takes its
      // row locks sorted by platform_id (see upsertMany); a single `UPDATE players … FROM (SELECT …
      // FROM players)` takes them in whatever order the planner scans the heap. Two lock orders over
      // the same rows is the textbook deadlock, and sorting the batches — which fixed batch-vs-batch
      // — cannot help when the other side is a sequential scan. So this side is brought into the
      // same order instead: a window of ids, locked ascending by platform_id, then written.
      //
      // Windowing also bounds the blast radius. The old statement held a row lock on every repaired
      // player for the length of one long transaction, against a table live ingest writes to
      // continuously; now nothing is held for longer than one small chunk.
      const CHUNK = 500;
      const best = (t: string) => `GREATEST(${t}.first_seen,
                          COALESCE((SELECT max(s.disconnected_at) FROM player_sessions s WHERE s.player_id = ${t}.id), ${t}.first_seen),
                          COALESCE((SELECT max(e.ts) FROM evt e WHERE e.actor_player_id = ${t}.id), ${t}.first_seen),
                          COALESCE((SELECT max(e.ts) FROM evt e WHERE e.victim_player_id = ${t}.id), ${t}.first_seen))`;
      let cursor = "";
      let repaired = 0;
      for (;;) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          // The window itself: ids only, no locks. Paged by platform_id rather than OFFSET so a
          // concurrent insert cannot make the sweep skip or revisit a player.
          const { rows: window } = await client.query(
            "SELECT platform_id FROM players WHERE platform_id > $1 ORDER BY platform_id LIMIT $2",
            [cursor, CHUNK],
          );
          if (!window.length) { await client.query("COMMIT"); break; }
          const edge = String(window[window.length - 1].platform_id);
          // Which of them are actually due, computed before anything is locked: locking 500 rows to
          // repair the two that need it is contention for nothing.
          const { rows: due } = await client.query(
            `SELECT q.id FROM (
               SELECT p2.id, p2.platform_id, p2.last_seen, ${best("p2")} AS best
                 FROM players p2 WHERE p2.platform_id > $1 AND p2.platform_id <= $2
             ) q WHERE q.last_seen > q.best`,
            [cursor, edge],
          );
          if (due.length) {
            const ids = due.map((r) => r.id as string);
            // Take the locks ascending by platform_id. The ORDER BY sorts before LockRows, so this
            // is the acquisition order — the same one every ingest batch uses.
            await client.query("SELECT 1 FROM players WHERE id = ANY($1) ORDER BY platform_id FOR UPDATE", [ids]);
            // Recomputed under the lock, so a roster bump that landed since the probe above is
            // judged on its merits rather than lowered on a stale reading.
            const { rowCount } = await client.query(
              `UPDATE players p SET last_seen = ev.best
                 FROM (SELECT p2.id, ${best("p2")} AS best FROM players p2 WHERE p2.id = ANY($1)) ev
                WHERE ev.id = p.id AND p.last_seen > ev.best`,
              [ids],
            );
            repaired += rowCount ?? 0;
          }
          await client.query("COMMIT");
          cursor = edge;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }
      return repaired;
    },
    findById: async (id: string) => {
      const { rows } = await this.pool.query("SELECT * FROM players WHERE id = $1", [id]);
      return rows[0] ? toPlayer(rows[0]) : null;
    },
    findByIds: async (ids: string[]): Promise<PlayerRow[]> => {
      if (!ids.length) return [];
      const { rows } = await this.pool.query("SELECT * FROM players WHERE id = ANY($1)", [[...new Set(ids)]]);
      return rows.map(toPlayer);
    },
    findByAnyIds: async (ids: string[]): Promise<PlayerRow[]> => {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return [];
      // A platform id is not a uuid, so `id = ANY` would throw on the mixed list — the cast is
      // filtered to the ones that can possibly be one.
      const uuids = unique.filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
      const { rows } = await this.pool.query(
        `SELECT * FROM players WHERE platform_id = ANY($1::text[]) ${uuids.length ? "OR id = ANY($2::uuid[])" : ""}`,
        uuids.length ? [unique, uuids] : [unique],
      );
      return rows.map(toPlayer);
    },
    findByPlatformId: async (platformId: string) => {
      const { rows } = await this.pool.query("SELECT * FROM players WHERE platform_id = $1 LIMIT 1", [platformId]);
      return rows[0] ? toPlayer(rows[0]) : null;
    },
    findByPlatformIds: async (platformIds: string[]) => {
      if (!platformIds.length) return [];
      const { rows } = await this.pool.query("SELECT * FROM players WHERE platform_id = ANY($1)", [platformIds]);
      return rows.map(toPlayer);
    },
    list: async (limit = 100) => {
      // NULLS LAST spelt out (a no-op on a NOT NULL column) so the ordering textually matches
      // players_last_seen_idx — the planner will not prove the equivalence on its own, and
      // without the index this is a full sort of the players table for a fifty-row picker.
      const { rows } = await this.pool.query("SELECT * FROM players ORDER BY last_seen DESC NULLS LAST, platform_id LIMIT $1", [limit]);
      return rows.map(toPlayer);
    },
    search: async (q: string, limit = 100) => {
      // Linked identities count as the player's ids: staff arrive holding whatever number another
      // tool (or the other game's roster) showed them — a Steam64, an Xbox XUID — and that number
      // lives in external_links, not on the row. A search that could not match it answered "no
      // such player" about somebody the directory knew perfectly well.
      const { rows } = await this.pool.query(
        `SELECT * FROM players WHERE name ILIKE $1 OR platform_id ILIKE $1
            OR EXISTS (SELECT 1 FROM external_links l WHERE l.player_id = players.id AND l.external_id ILIKE $1)
          ORDER BY last_seen DESC NULLS LAST, platform_id LIMIT $2`,
        [containsLike(q), limit],
      );
      return rows.map(toPlayer);
    },
    directory: async (f: PlayerDirectoryFilters): Promise<PlayerDirectoryRow[]> => {
      const { join, where, args, vipSelect } = directoryFrom(f);
      const q = f.q?.trim();
      // The column only; the direction is the caller's, because every header in the directory is
      // clickable and a second click has to reverse it.
      const sortCol: Record<string, string> = {
        lastSeen: "p.last_seen", firstSeen: "p.first_seen", name: "lower(p.name)", platform: "lower(p.platform)",
        kills: "coalesce(s.kills, 0)", teamkills: "coalesce(s.teamkills, 0)",
        playtime: "coalesce(s.playtime_sec, 0)", visits: "coalesce(s.visits, 0)",
      };
      const col = sortCol[f.sort ?? "lastSeen"] ?? sortCol.lastSeen;
      const dir = f.sortDir === "asc" ? "ASC" : "DESC";
      // Paging needs a total order: every sort above can tie (a thousand players with 0 kills), and
      // rows that tie can come back in any order, which would make the same row appear on two pages
      // and another never appear at all. The id breaks every tie, so pages don't overlap or skip.
      /*
       * Keyset when the caller gives a cursor, offset otherwise. The directory is a view of MUTABLE
       * rows — last_seen changes on every connect, kills on every fight — so the value a row is
       * sorted by moves under the reader, and offset paging then repeats rows or skips them
       * depending on which way it moved. "Give me what comes after this exact position" survives
       * that; "give me rows 50-99 of whatever the order is now" cannot.
       *
       * The predicate has to respect NULLS LAST, which only bites on `lower(p.name)` — every other
       * sort expression is NOT NULL or coalesced. With DESC NULLS LAST the rows after a non-null v
       * are: smaller values, then all the nulls, then the same value with a larger id.
       */
      const keyset: string[] = [];
      if (f.after) {
        const cmp = dir === "ASC" ? ">" : "<";
        if (f.after.value === null) {
          // Already among the nulls at the end: only later ids remain.
          args.push(f.after.id);
          keyset.push(`(${col} IS NULL AND p.id > $${args.length})`);
        } else {
          args.push(f.after.value);
          const vArg = args.length;
          args.push(f.after.id);
          const idArg = args.length;
          keyset.push(`(${col} ${cmp} $${vArg} OR ${col} IS NULL OR (${col} = $${vArg} AND p.id > $${idArg}))`);
        }
      }
      const allWhere = [...where, ...keyset];
      // Searching is a question about NAMES, so the answer ranks by how well the name matches
      // before anything else: exact, then starts-with, then contains, then id-only matches. The
      // player literally called "Pepper" must never sit under ninety-eight Sgt Peppers because
      // they were seen less recently. Skipped for cursor callers — the keyset predicate describes
      // a position in the (column, id) order alone, and reshaping the order under a cursor would
      // page wrongly. The panel pages searches by offset, so it always gets the ranking.
      let rank = "";
      if (q && !f.after) {
        args.push(q.toLowerCase());
        const qa = args.length;
        rank = `CASE WHEN lower(p.name) = $${qa} THEN 0
                     WHEN strpos(lower(p.name), $${qa}) = 1 THEN 1
                     WHEN strpos(lower(p.name), $${qa}) > 0 THEN 2
                     ELSE 3 END, `;
      }
      args.push(Math.min(Math.max(f.limit ?? 100, 1), 500));
      const limitArg = args.length;
      // A cursor supersedes offset: mixing them would skip a page's worth of rows.
      const offsetSql = f.after ? "" : (() => { args.push(Math.max(f.offset ?? 0, 0)); return ` OFFSET $${args.length}`; })();
      const { rows } = await this.pool.query(
        `SELECT p.*,
                coalesce(s.kills, 0) AS d_kills, coalesce(s.deaths, 0) AS d_deaths, coalesce(s.teamkills, 0) AS d_teamkills,
                coalesce(s.visits, 0) AS d_visits, coalesce(s.playtime_sec, 0) AS d_playtime_sec,
                coalesce(f.watchlist, false) AS d_watchlist,
                ${vipSelect} AS d_vip,
                ${col} AS d_sort_key
         FROM players p
         ${join}
         LEFT JOIN player_flags f ON f.player_id = p.id
         ${allWhere.length ? `WHERE ${allWhere.join(" AND ")}` : ""}
         ORDER BY ${rank}${col} ${dir} NULLS LAST, p.id
         LIMIT $${limitArg}${offsetSql}`,
        args,
      );
      return rows.map((r) => ({
        ...toPlayer(r),
        kills: Number(r.d_kills), deaths: Number(r.d_deaths), teamkills: Number(r.d_teamkills),
        visits: Number(r.d_visits), playtimeSec: Number(r.d_playtime_sec),
        watchlist: Boolean(r.d_watchlist), vip: Boolean(r.d_vip),
        // Timestamps come back as Date objects; the cursor has to survive JSON, so normalise here.
        sortKey: r.d_sort_key instanceof Date ? r.d_sort_key.toISOString() : (r.d_sort_key ?? null),
      }));
    },
    directoryCount: async (f: PlayerDirectoryFilters): Promise<number> => {
      // Same WHERE as the listing, from the same builder — if these two could drift, the directory
      // would report a total that its own pages never reach. Without the totals: no condition reads
      // them, and working them out for every player only to count the rows was most of the time a
      // server's list took (190ms of 220 on a 100k-player install).
      const { where, args } = directoryFrom(f);
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n
         FROM players p
         LEFT JOIN player_flags f ON f.player_id = p.id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
        args,
      );
      return rows[0]?.n ?? 0;
    },
    count: async (): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM players");
      return rows[0]?.n ?? 0;
    },
  };

  /*
   * Clan tags. `cur` is each player's newest tag; it is the tag they wear NOW when it was seen
   * within the grace of the player's own last sighting (the roster records tags once a minute,
   * while log lines keep moving last_seen). Both partial indexes on player_aliases (kind = 'clan')
   * keep these off the much larger name history.
   */
  clanTags = {
    tags: async (): Promise<string[]> => {
      const { rows } = await this.pool.query("SELECT DISTINCT value FROM player_aliases WHERE kind = 'clan'");
      return rows.map((r) => r.value as string);
    },
    spellings: async (opts: ClanScope = {}): Promise<ClanSpellingRow[]> => {
      const args: unknown[] = [CLAN_CURRENT_GRACE_SEC];
      const game = clanScopeSql(opts, args);
      const { rows } = await this.pool.query(
        `WITH cur AS (
           SELECT DISTINCT ON (a.player_id) a.player_id, a.value, a.last_seen
             FROM player_aliases a WHERE a.kind = 'clan'
            ORDER BY a.player_id, a.last_seen DESC
         )
         SELECT a.value AS tag, count(*)::int AS ever,
                count(*) FILTER (WHERE c.value = a.value AND c.last_seen >= p.last_seen - ($1::int * interval '1 second'))::int AS now,
                max(a.last_seen) AS last_seen
           FROM player_aliases a
           JOIN players p ON p.id = a.player_id
           JOIN cur c ON c.player_id = a.player_id
          WHERE a.kind = 'clan' ${game}
          GROUP BY a.value`,
        args,
      );
      return rows.map((r) => ({ tag: r.tag, ever: Number(r.ever), now: Number(r.now), lastSeen: new Date(r.last_seen).toISOString() }));
    },
    groupStats: async (groups: { key: string; tags: string[] }[], opts: ClanScope = {}): Promise<ClanGroupStatsRow[]> => {
      const tags: string[] = [];
      const keys: string[] = [];
      for (const g of groups) for (const t of g.tags) { tags.push(t); keys.push(g.key); }
      if (!tags.length) return [];
      const args: unknown[] = [CLAN_CURRENT_GRACE_SEC, tags, keys];
      const game = clanScopeSql(opts, args);
      const { rows } = await this.pool.query(
        `WITH m AS (SELECT * FROM unnest($2::text[], $3::text[]) AS m(tag, key)),
         cur AS (
           SELECT DISTINCT ON (a.player_id) a.player_id, a.value, a.last_seen
             FROM player_aliases a WHERE a.kind = 'clan'
            ORDER BY a.player_id, a.last_seen DESC
         )
         SELECT m.key, count(DISTINCT a.player_id)::int AS ever,
                count(DISTINCT a.player_id) FILTER (WHERE c.value = a.value AND c.last_seen >= p.last_seen - ($1::int * interval '1 second'))::int AS now,
                max(a.last_seen) AS last_seen
           FROM player_aliases a
           JOIN m ON m.tag = a.value
           JOIN players p ON p.id = a.player_id
           JOIN cur c ON c.player_id = a.player_id
          WHERE a.kind = 'clan' ${game}
          GROUP BY m.key`,
        args,
      );
      return rows.map((r) => ({ key: r.key, ever: Number(r.ever), now: Number(r.now), lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null }));
    },
    members: async (q: ClanMembersQuery): Promise<{ rows: ClanMemberRow[]; total: number }> => {
      const tags = [...new Set(q.tags.map((t) => t.trim()).filter(Boolean))];
      if (!tags.length) return { rows: [], total: 0 };
      const args: unknown[] = [CLAN_CURRENT_GRACE_SEC, tags];
      const where: string[] = ["true"];
      const scope = clanScopeSql(q, args);
      if (scope) where.push(scope.replace(/^AND /, ""));
      if (q.seenFrom) { args.push(q.seenFrom); where.push(`p.last_seen >= $${args.length}`); }
      const status = q.status === "now" ? "WHERE wearing_now" : q.status === "former" ? "WHERE NOT wearing_now" : "";
      args.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
      const limitArg = args.length;
      args.push(Math.max(q.offset ?? 0, 0));
      const offsetArg = args.length;
      const { rows } = await this.pool.query(
        `WITH worn AS (
           SELECT a.player_id, min(a.first_seen) AS tag_first, max(a.last_seen) AS tag_last,
                  (array_agg(a.value ORDER BY a.last_seen DESC))[1] AS tag
             FROM player_aliases a
            WHERE a.kind = 'clan' AND a.value = ANY($2::text[])
            GROUP BY a.player_id
         ), cur AS (
           SELECT DISTINCT ON (a.player_id) a.player_id, a.value, a.last_seen
             FROM player_aliases a JOIN worn w ON w.player_id = a.player_id
            WHERE a.kind = 'clan'
            ORDER BY a.player_id, a.last_seen DESC
         ), listed AS (
           SELECT p.*, w.tag, w.tag_first, w.tag_last,
                  CASE WHEN c.last_seen >= p.last_seen - ($1::int * interval '1 second') THEN c.value END AS current_tag
             FROM worn w
             JOIN players p ON p.id = w.player_id
             LEFT JOIN cur c ON c.player_id = w.player_id
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ), judged AS (
           SELECT *, coalesce(current_tag = ANY($2::text[]), false) AS wearing_now FROM listed
         )
         SELECT *, count(*) OVER () AS total_rows FROM judged ${status}
          ORDER BY wearing_now DESC, tag_last DESC, id
          LIMIT $${limitArg} OFFSET $${offsetArg}`,
        args,
      );
      return {
        rows: rows.map((r) => ({
          player: toPlayer(r), tag: r.tag,
          firstSeen: new Date(r.tag_first).toISOString(), lastSeen: new Date(r.tag_last).toISOString(),
          wearingNow: Boolean(r.wearing_now), currentTag: r.current_tag ?? null,
        })),
        total: rows.length ? Number(rows[0].total_rows) : 0,
      };
    },
  };

  playerAliases = {
    list: async (playerId: string): Promise<PlayerAliasRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_aliases WHERE player_id = $1 ORDER BY last_seen DESC", [playerId]);
      return rows.map(toAlias);
    },
    record: async (playerId: string, kind: "name" | "clan", value: string, ts: string): Promise<void> => {
      await this.recordAlias(playerId, kind, value, ts);
    },
    recordMany: async (rows: { playerId: string; kind: "name" | "clan"; value: string; ts: string }[]): Promise<void> => {
      // Fold duplicates first: ON CONFLICT DO UPDATE cannot touch the same row twice in one
      // statement, and an archive hands the same (player, kind, name) over repeatedly. The fold
      // widens first/last exactly as the repeated single calls would and sums the count, so the
      // batch is arithmetically identical to the one-at-a-time path it replaces.
      const merged = new Map<string, { playerId: string; kind: string; value: string; first: string; last: string; n: number }>();
      for (const r of rows) {
        const v = r.value.trim();
        if (!r.playerId || !v || !r.ts) continue;
        const key = `${r.playerId}\u0000${r.kind}\u0000${v}`;
        const cur = merged.get(key);
        if (!cur) merged.set(key, { playerId: r.playerId, kind: r.kind, value: v, first: r.ts, last: r.ts, n: 1 });
        else { if (r.ts < cur.first) cur.first = r.ts; if (r.ts > cur.last) cur.last = r.ts; cur.n += 1; }
      }
      if (merged.size === 0) return;
      const vals: unknown[] = [];
      // Sorted for consistent lock order across concurrent flushes (deadlock prevention).
      const tuples = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d], n) => {
        vals.push(d.playerId, d.kind, d.value, d.first, d.last, d.n);
        const b = n * 6;
        return `($${b + 1}::uuid,$${b + 2}::text,$${b + 3}::text,$${b + 4}::timestamptz,$${b + 5}::timestamptz,$${b + 6}::int)`;
      });
      await this.pool.query(
        `INSERT INTO player_aliases (player_id, kind, value, first_seen, last_seen, seen_count)
         SELECT player_id, kind, value, first_seen, last_seen, seen_count
         FROM (VALUES ${tuples.join(",")}) AS v(player_id, kind, value, first_seen, last_seen, seen_count)
         ON CONFLICT (player_id, kind, value) DO UPDATE SET
           last_seen = GREATEST(player_aliases.last_seen, EXCLUDED.last_seen),
           first_seen = LEAST(player_aliases.first_seen, EXCLUDED.first_seen),
           seen_count = player_aliases.seen_count + EXCLUDED.seen_count`,
        vals,
      );
    },
  };

  externalLinks = {
    distinctExternalIds: async (provider: string): Promise<string[]> => {
      const { rows } = await this.pool.query(
        "SELECT DISTINCT external_id FROM external_links WHERE provider = $1 ORDER BY external_id", [provider]);
      return rows.map((r) => r.external_id as string);
    },
    list: async (playerId: string): Promise<ExternalLinkRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM external_links WHERE player_id = $1 ORDER BY provider", [playerId]);
      return rows.map(toLink);
    },
    set: async (playerId: string, provider: string, externalId: string | null, byName: string | null = null): Promise<void> => {
      const id = externalId?.trim();
      if (!id) {
        await this.pool.query("DELETE FROM external_links WHERE player_id = $1 AND provider = $2", [playerId, provider]);
        return;
      }
      await this.pool.query(
        `INSERT INTO external_links (player_id, provider, external_id, created_by_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (player_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, created_by_name = EXCLUDED.created_by_name, created_at = now()`,
        [playerId, provider, id, byName],
      );
    },
    findPlayer: async (provider: string, externalId: string): Promise<PlayerRow | null> => {
      const { rows } = await this.pool.query(
        "SELECT p.* FROM external_links l JOIN players p ON p.id = l.player_id WHERE l.provider = $1 AND l.external_id = $2 LIMIT 1",
        [provider, externalId],
      );
      return rows[0] ? toPlayer(rows[0]) : null;
    },
    findPlayers: async (provider: string, externalId: string): Promise<PlayerRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT p.* FROM external_links l JOIN players p ON p.id = l.player_id WHERE l.provider = $1 AND l.external_id = $2 ORDER BY p.last_seen DESC",
        [provider, externalId],
      );
      return rows.map(toPlayer);
    },
    linkedAmong: async (playerIds: string[], provider: string): Promise<Set<string>> => {
      if (!playerIds.length) return new Set();
      const { rows } = await this.pool.query(
        "SELECT DISTINCT player_id FROM external_links WHERE provider = $1 AND player_id = ANY($2::uuid[])",
        [provider, playerIds],
      );
      return new Set((rows as { player_id: string }[]).map((r) => r.player_id));
    },
    findPlayersByExternalId: async (externalId: string): Promise<PlayerRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT ON (p.id) p.* FROM external_links l JOIN players p ON p.id = l.player_id
          WHERE l.external_id = $1 ORDER BY p.id, p.last_seen DESC`,
        [externalId],
      );
      return rows.map(toPlayer);
    },
  };

  playerTags = {
    list: async (playerId: string): Promise<PlayerTagRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_tags WHERE player_id = $1 ORDER BY created_at", [playerId]);
      return rows.map(toTag);
    },
    labelsByPlatformIds: async (platformIds: string[]): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>();
      const ids = [...new Set(platformIds.filter(Boolean))];
      if (!ids.length) return out;
      // One join instead of two queries per player. players.platform_id is uniquely indexed and
      // player_tags is indexed on player_id, so this is two index scans regardless of roster size.
      const { rows } = await this.pool.query(
        `SELECT p.platform_id, t.label
           FROM players p
           JOIN player_tags t ON t.player_id = p.id
          WHERE p.platform_id = ANY($1::text[])
          ORDER BY t.created_at`,
        [ids],
      );
      for (const r of rows) {
        const key = String(r.platform_id);
        const list = out.get(key);
        if (list) list.push(r.label as string);
        else out.set(key, [r.label as string]);
      }
      return out;
    },
    add: async (input: NewPlayerTag): Promise<PlayerTagRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO player_tags (id, player_id, label, note, created_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [randomUUID(), input.playerId, input.label, input.note ?? null, input.createdByName],
      );
      return toTag(rows[0]);
    },
    remove: async (id: string): Promise<PlayerTagRow | null> => {
      const { rows } = await this.pool.query("DELETE FROM player_tags WHERE id = $1 RETURNING *", [id]);
      return rows[0] ? toTag(rows[0]) : null;
    },
  };

  playerNotes = {
    list: async (playerId: string, limit = 100): Promise<PlayerNoteRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_notes WHERE player_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [playerId, limit]);
      return rows.map(toNote);
    },
    create: async (input: NewPlayerNote): Promise<PlayerNoteRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO player_notes (id, player_id, author_user_id, author_name, body, created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now())) RETURNING *`,
        [randomUUID(), input.playerId, input.authorUserId ?? null, input.authorName, input.body, input.createdAt ?? null],
      );
      return toNote(rows[0]);
    },
    backdate: async (id: string, createdAt: string): Promise<void> => {
      await this.pool.query("UPDATE player_notes SET created_at = LEAST(created_at, $2::timestamptz) WHERE id = $1", [id, createdAt]);
    },
  };

  playerIps = {
    record: async (playerId: string, ip: string, ts: string, source: string): Promise<void> => {
      await this.pool.query(
        `INSERT INTO player_ips (player_id, ip, first_seen, last_seen, seen_count, source)
         VALUES ($1,$2,$3,$3,1,$4)
         ON CONFLICT (player_id, ip) DO UPDATE SET
           first_seen = LEAST(player_ips.first_seen, EXCLUDED.first_seen),
           last_seen  = GREATEST(player_ips.last_seen, EXCLUDED.last_seen),
           seen_count = player_ips.seen_count + 1`,
        [playerId, ip, ts, source],
      );
    },
    list: async (playerId: string): Promise<PlayerIpRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_ips WHERE player_id = $1 ORDER BY last_seen DESC", [playerId]);
      return rows.map(toPlayerIp);
    },
    byIp: async (ip: string): Promise<PlayerIpRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_ips WHERE ip = $1 ORDER BY last_seen DESC", [ip]);
      return rows.map(toPlayerIp);
    },
    byIps: async (ips: string[]): Promise<PlayerIpRow[]> => {
      if (!ips.length) return [];
      const { rows } = await this.pool.query("SELECT * FROM player_ips WHERE ip = ANY($1) ORDER BY last_seen DESC", [ips]);
      return rows.map(toPlayerIp);
    },
  };

  playerFlags = {
    get: async (playerId: string): Promise<PlayerFlagsRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM player_flags WHERE player_id = $1", [playerId]);
      return rows[0] ? toFlags(rows[0]) : null;
    },
    set: async (playerId: string, patch: PlayerFlagsPatch, by: { userId: string | null; name: string }): Promise<PlayerFlagsRow> => {
      // Watch provenance: unwatching clears it ON THE CURRENT ROW ONLY (the permanent history
      // below keeps every spell); provided values overwrite; a fresh watch-on with nothing
      // provided defaults to the acting user and now. Anything else (VIP-only patches,
      // re-flagging someone already watched) leaves the original story intact.
      const before = await this.playerFlags.get(playerId);
      const { rows } = await this.pool.query(
        `INSERT INTO player_flags (player_id, watchlist, vip, updated_by_name, updated_at, watch_reason, watch_by, watch_at)
         VALUES ($1, COALESCE($2, false), COALESCE($3, false), $4, now(),
                 CASE WHEN COALESCE($2, false) THEN $5 END,
                 CASE WHEN COALESCE($2, false) THEN COALESCE($6, $4) END,
                 CASE WHEN COALESCE($2, false) THEN COALESCE($7::timestamptz, now()) END)
         ON CONFLICT (player_id) DO UPDATE SET
           watchlist = COALESCE($2, player_flags.watchlist),
           vip = COALESCE($3, player_flags.vip),
           updated_by_name = $4, updated_at = now(),
           watch_reason = CASE WHEN $2 = false THEN NULL
                               WHEN $5::text IS NOT NULL THEN $5
                               ELSE player_flags.watch_reason END,
           watch_by     = CASE WHEN $2 = false THEN NULL
                               WHEN $6::text IS NOT NULL THEN $6
                               WHEN $2 = true AND NOT player_flags.watchlist THEN $4
                               ELSE player_flags.watch_by END,
           watch_at     = CASE WHEN $2 = false THEN NULL
                               WHEN $7::timestamptz IS NOT NULL THEN $7
                               WHEN $2 = true AND NOT player_flags.watchlist THEN now()
                               ELSE player_flags.watch_at END
         RETURNING *`,
        [playerId, patch.watchlist ?? null, patch.vip ?? null, by.name, patch.watchReason ?? null, patch.watchBy ?? null, patch.watchAt ?? null],
      );
      const after = toFlags(rows[0]);
      // Permanent history: arming opens a spell, unwatching closes the open one, and updating an
      // active watch's provenance (a re-import filling in the original story) syncs the open row.
      if (after.watchlist && !before?.watchlist) {
        await this.pool.query(
          "INSERT INTO watch_history (id, player_id, reason, watched_by, watched_at) VALUES ($1, $2, $3, $4, $5)",
          [randomUUID(), playerId, after.watchReason, after.watchBy, after.watchAt ?? new Date().toISOString()],
        );
      } else if (!after.watchlist && before?.watchlist) {
        await this.pool.query(
          "UPDATE watch_history SET removed_by = $2, removed_at = now() WHERE player_id = $1 AND removed_at IS NULL",
          [playerId, by.name],
        );
      } else if (after.watchlist && before?.watchlist && (patch.watchReason != null || patch.watchBy != null || patch.watchAt != null)) {
        await this.pool.query(
          "UPDATE watch_history SET reason = $2, watched_by = $3, watched_at = $4 WHERE player_id = $1 AND removed_at IS NULL",
          [playerId, after.watchReason, after.watchBy, after.watchAt],
        );
      }
      return after;
    },
    listWatched: async (): Promise<PlayerFlagsRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_flags WHERE watchlist");
      return rows.map(toFlags);
    },
    watchHistory: async (playerId: string): Promise<WatchHistoryRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM watch_history WHERE player_id = $1 ORDER BY watched_at DESC, id", [playerId]);
      return rows.map((r: any) => ({
        id: r.id, playerId: r.player_id, reason: r.reason ?? null, watchedBy: r.watched_by ?? null,
        watchedAt: new Date(r.watched_at).toISOString(),
        removedBy: r.removed_by ?? null, removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null,
      }));
    },
  };

  // A reason is ACTIVE while it is neither closed nor past its own expiry. SQL fragment kept in
  // one place so list/lapsed/active reads cannot drift on what "active" means.
  private static readonly WATCH_ACTIVE = "(removed_at IS NULL AND (expires_at IS NULL OR expires_at > now()))";

  watchReasons = {
    list: async (playerId: string): Promise<WatchReasonRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM watch_reasons WHERE player_id = $1
         ORDER BY ${PostgresRepository.WATCH_ACTIVE} DESC, added_at DESC, id`,
        [playerId],
      );
      return rows.map(toWatchReason);
    },
    listActiveByPlayers: async (playerIds: string[]): Promise<Map<string, WatchReasonRow[]>> => {
      const out = new Map<string, WatchReasonRow[]>();
      if (!playerIds.length) return out;
      const { rows } = await this.pool.query(
        `SELECT * FROM watch_reasons WHERE player_id = ANY($1) AND ${PostgresRepository.WATCH_ACTIVE}
         ORDER BY added_at DESC, id`,
        [playerIds],
      );
      for (const r of rows) {
        const row = toWatchReason(r);
        const arr = out.get(row.playerId) ?? [];
        arr.push(row);
        out.set(row.playerId, arr);
      }
      return out;
    },
    get: async (id: string): Promise<WatchReasonRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM watch_reasons WHERE id = $1", [id]);
      return rows[0] ? toWatchReason(rows[0]) : null;
    },
    add: async (input: { playerId: string; reason: string; addedBy: string | null; addedByUserId?: string | null; expiresAt?: string | null; addedAt?: string }): Promise<WatchReasonRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO watch_reasons (id, player_id, reason, added_by, added_by_user_id, added_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7) RETURNING *`,
        [randomUUID(), input.playerId, input.reason, input.addedBy, input.addedByUserId ?? null, input.addedAt ?? null, input.expiresAt ?? null],
      );
      return toWatchReason(rows[0]);
    },
    edit: async (id: string, patch: { reason?: string; expiresAt?: string | null }, by: string | null): Promise<WatchReasonRow | null> => {
      // Read-modify-write: the previous version is archived onto the row FIRST, so the record of
      // what it used to say survives the edit. A closed reason is history and cannot be rewritten.
      const { rows: cur } = await this.pool.query("SELECT * FROM watch_reasons WHERE id = $1 AND removed_at IS NULL", [id]);
      if (!cur[0]) return null;
      const before = toWatchReason(cur[0]);
      const prev = { reason: before.reason, expiresAt: before.expiresAt, editedBy: by, editedAt: new Date().toISOString() };
      const reason = patch.reason !== undefined ? patch.reason : before.reason;
      const expiresAt = patch.expiresAt !== undefined ? patch.expiresAt : before.expiresAt;
      const { rows } = await this.pool.query(
        "UPDATE watch_reasons SET reason = $2, expires_at = $3, edits = edits || $4::jsonb WHERE id = $1 RETURNING *",
        [id, reason, expiresAt, JSON.stringify([prev])],
      );
      return rows[0] ? toWatchReason(rows[0]) : null;
    },
    remove: async (id: string, by: string | null): Promise<WatchReasonRow | null> => {
      const { rows } = await this.pool.query(
        "UPDATE watch_reasons SET removed_by = $2, removed_at = now() WHERE id = $1 AND removed_at IS NULL RETURNING *",
        [id, by],
      );
      return rows[0] ? toWatchReason(rows[0]) : null;
    },
    removeAll: async (playerId: string, by: string | null): Promise<number> => {
      const { rowCount } = await this.pool.query(
        "UPDATE watch_reasons SET removed_by = $2, removed_at = now() WHERE player_id = $1 AND removed_at IS NULL",
        [playerId, by],
      );
      return rowCount ?? 0;
    },
    lapsedWatchers: async (): Promise<string[]> => {
      const { rows } = await this.pool.query(
        `SELECT f.player_id FROM player_flags f
         WHERE f.watchlist AND NOT EXISTS (
           SELECT 1 FROM watch_reasons r WHERE r.player_id = f.player_id AND ${PostgresRepository.WATCH_ACTIVE}
         )`,
      );
      return rows.map((r: any) => r.player_id as string);
    },
  };

  approvals = {
    create: async (input: { requesterUserId: string; requesterName: string; note?: string | null; status?: "draft" | "open" }): Promise<ApprovalRequestRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO approval_requests (id, requester_user_id, requester_name, status, note, submitted_at)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $4 = 'open' THEN now() END) RETURNING *`,
        [randomUUID(), input.requesterUserId, input.requesterName, input.status ?? "draft", input.note ?? null],
      );
      return toApprovalRequest(rows[0], []);
    },
    get: async (id: string): Promise<ApprovalRequestRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM approval_requests WHERE id = $1", [id]);
      if (!rows[0]) return null;
      const { rows: lines } = await this.pool.query("SELECT * FROM approval_lines WHERE request_id = $1 ORDER BY seq, created_at", [id]);
      return toApprovalRequest(rows[0], lines.map(toApprovalLine));
    },
    findDraft: async (requesterUserId: string): Promise<ApprovalRequestRow | null> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM approval_requests WHERE requester_user_id = $1 AND status = 'draft' ORDER BY created_at DESC LIMIT 1",
        [requesterUserId],
      );
      return rows[0] ? this.approvals.get(rows[0].id) : null;
    },
    list: async (q: { status?: ApprovalRequestStatus[]; requesterUserId?: string; limit?: number } = {}): Promise<ApprovalRequestRow[]> => {
      const where: string[] = []; const args: unknown[] = [];
      if (q.status?.length) { args.push(q.status); where.push(`status = ANY($${args.length})`); }
      if (q.requesterUserId) { args.push(q.requesterUserId); where.push(`requester_user_id = $${args.length}`); }
      args.push(Math.min(q.limit ?? 200, 500));
      const { rows } = await this.pool.query(
        `SELECT * FROM approval_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT $${args.length}`, args,
      );
      if (!rows.length) return [];
      const { rows: lines } = await this.pool.query(
        "SELECT * FROM approval_lines WHERE request_id = ANY($1) ORDER BY seq, created_at", [rows.map((r: any) => r.id)],
      );
      const byReq = new Map<string, ApprovalLineRow[]>();
      for (const l of lines.map(toApprovalLine)) {
        const list = byReq.get(l.requestId); if (list) list.push(l); else byReq.set(l.requestId, [l]);
      }
      return rows.map((r: any) => toApprovalRequest(r, byReq.get(r.id) ?? []));
    },
    addLine: async (requestId: string, input: NewApprovalLine): Promise<ApprovalLineRow | null> => {
      // Only a draft or an open request may grow; the state is checked in the same statement so a
      // concurrent resolve cannot slip a line into a closed request.
      const { rows } = await this.pool.query(
        `INSERT INTO approval_lines (id, request_id, seq, server_id, capability, kind, payload, player_id, player_name)
         SELECT $1, r.id, $3, $4, $5, $6, $7, $8, $9 FROM approval_requests r WHERE r.id = $2 AND r.status IN ('draft','open')
         RETURNING *`,
        [randomUUID(), requestId, input.seq ?? 0, input.serverId ?? null, input.capability, input.kind, JSON.stringify(input.payload), input.playerId ?? null, input.playerName ?? null],
      );
      if (rows[0]) await this.pool.query("UPDATE approval_requests SET updated_at = now() WHERE id = $1", [requestId]);
      return rows[0] ? toApprovalLine(rows[0]) : null;
    },
    removeLine: async (requestId: string, lineId: string): Promise<boolean> => {
      // Dropping a row is activity too: updated_at is what the stale-draft sweep reads.
      await this.pool.query("UPDATE approval_requests SET updated_at = now() WHERE id = $1 AND status = 'draft'", [requestId]);
      const { rowCount } = await this.pool.query(
        `DELETE FROM approval_lines l USING approval_requests r
         WHERE l.id = $2 AND l.request_id = $1 AND r.id = l.request_id AND r.status = 'draft'`,
        [requestId, lineId],
      );
      return (rowCount ?? 0) > 0;
    },
    submit: async (id: string, expiresAt: string): Promise<ApprovalRequestRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE approval_requests SET status = 'open', submitted_at = now(), expires_at = $2, updated_at = now()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id, expiresAt],
      );
      return rows[0] ? this.approvals.get(id) : null;
    },
    discardDraft: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM approval_requests WHERE id = $1 AND status = 'draft'", [id]);
      return (rowCount ?? 0) > 0;
    },
    parkDraft: async (requesterUserId: string, parked: boolean): Promise<ApprovalRequestRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE approval_requests SET parked_at = ${parked ? "now()" : "NULL"}, updated_at = now()
         WHERE requester_user_id = $1 AND status = 'draft' RETURNING id`,
        [requesterUserId],
      );
      return rows[0] ? this.approvals.get(rows[0].id) : null;
    },
    discardStaleDrafts: async (cutoffIso: string): Promise<ApprovalRequestRow[]> => {
      // Lines go with the request (ON DELETE CASCADE). RETURNING the rows lets the sweep say
      // whose carts it tidied without a second read.
      const { rows } = await this.pool.query(
        "DELETE FROM approval_requests WHERE status = 'draft' AND updated_at < $1 RETURNING *",
        [cutoffIso],
      );
      return rows.map((r: any) => toApprovalRequest(r, []));
    },
    withdraw: async (id: string): Promise<ApprovalRequestRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE approval_requests SET status = 'withdrawn', resolved_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'open' RETURNING id`, [id],
      );
      if (!rows[0]) return null;
      await this.pool.query("UPDATE approval_lines SET state = 'voided' WHERE request_id = $1 AND state = 'pending'", [id]);
      return this.approvals.get(id);
    },
    decideLine: async (lineId: string, d: { state: "approved" | "denied"; byUserId: string; byName: string; denyReason?: string | null; modified?: Record<string, { requested: number; granted: number }> | null }): Promise<ApprovalLineRow | null> => {
      // The race lives here: WHERE state = 'pending' (and the request still open) means exactly
      // one of two simultaneous clicks transitions the row; the loser gets null back.
      const { rows } = await this.pool.query(
        `UPDATE approval_lines l SET state = $2, decided_by_user_id = $3, decided_by_name = $4, decided_at = now(),
                deny_reason = $5, modified = $6
         FROM approval_requests r
         WHERE l.id = $1 AND l.state = 'pending' AND r.id = l.request_id AND r.status = 'open'
         RETURNING l.*`,
        [lineId, d.state, d.byUserId, d.byName, d.denyReason ?? null, d.modified ? JSON.stringify(d.modified) : null],
      );
      return rows[0] ? toApprovalLine(rows[0]) : null;
    },
    markApplied: async (lineId: string, error?: string | null): Promise<ApprovalLineRow | null> => {
      const { rows } = await this.pool.query(
        "UPDATE approval_lines SET applied_at = now(), apply_error = $2 WHERE id = $1 RETURNING *",
        [lineId, error ?? null],
      );
      return rows[0] ? toApprovalLine(rows[0]) : null;
    },
    markExecuted: async (lineId: string, by: { userId: string; name: string }, error?: string | null): Promise<ApprovalLineRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE approval_lines SET state = 'executed', decided_by_user_id = $2, decided_by_name = $3,
                decided_at = now(), applied_at = now(), apply_error = $4
         WHERE id = $1 AND state = 'pending' RETURNING *`,
        [lineId, by.userId, by.name, error ?? null],
      );
      return rows[0] ? toApprovalLine(rows[0]) : null;
    },
    settle: async (requestId: string): Promise<ApprovalRequestRow | null> => {
      await this.pool.query(
        `UPDATE approval_requests r SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE r.id = $1 AND r.status = 'open'
           AND NOT EXISTS (SELECT 1 FROM approval_lines l WHERE l.request_id = r.id AND l.state = 'pending')`,
        [requestId],
      );
      return this.approvals.get(requestId);
    },
    expireDue: async (nowIso: string): Promise<ApprovalRequestRow[]> => {
      const { rows } = await this.pool.query(
        `UPDATE approval_requests SET status = 'expired', resolved_at = now(), updated_at = now()
         WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= $1 RETURNING id`,
        [nowIso],
      );
      if (!rows.length) return [];
      await this.pool.query("UPDATE approval_lines SET state = 'voided' WHERE request_id = ANY($1) AND state = 'pending'", [rows.map((r: any) => r.id)]);
      const out: ApprovalRequestRow[] = [];
      for (const r of rows) { const full = await this.approvals.get(r.id); if (full) out.push(full); }
      return out;
    },
  };

  events = {
    insert: async (rows: NewEvt[]): Promise<NewEvt[]> => {
      if (rows.length === 0) return [];
      const cols = 11;
      const insertedKeys = new Set<string | null>();
      // Chunked because the wire protocol caps a statement at 65,535 parameters: at eleven columns
      // that is 5,957 rows, past which the driver fails with "bind message has N parameter formats
      // but 0 parameters" — a message that says nothing about the real cause. Today's callers stay
      // well under it (the log poll is a few hundred, the CRCON import flushes at 500), so this is
      // not a live bug; it is a trap set for whoever raises a flush threshold later.
      for (let start = 0; start < rows.length; start += EVT_INSERT_CHUNK) {
        const slice = rows.slice(start, start + EVT_INSERT_CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((r, i) => {
          const b = i * cols;
          // Kill rows' sides in their short spelling (compact-json.ts). Stringified here: the driver
          // would write a list as a Postgres array, not as json.
          const data = packKillData(r.kind, r.data);
          values.push(randomUUID(), r.serverId, r.ts, r.kind, r.actorPlayerId ?? null, r.actorName ?? null, r.victimPlayerId ?? null, r.victimName ?? null, r.weapon ?? null, data == null ? null : JSON.stringify(data), r.dedupeKey ?? null);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
        });
        // ON CONFLICT DO NOTHING makes ingestion idempotent; RETURNING tells us which rows were
        // actually new so the caller bumps career stats only once per event. The guard is the
        // key's hash (migration 149), so the conflict target names that expression.
        const { rows: ret } = await this.pool.query(
          `INSERT INTO evt (id, server_id, ts, kind, actor_player_id, actor_name, victim_player_id, victim_name, weapon, data, dedupe_key)
           VALUES ${tuples.join(",")}
           ON CONFLICT (server_id, (md5(dedupe_key)::uuid), ts) DO NOTHING
           RETURNING dedupe_key`,
          values,
        );
        for (const r of ret as { dedupe_key: string | null }[]) insertedKeys.add(r.dedupe_key);
      }
      // Rows with a null dedupe_key never conflict, so they're always inserted.
      return rows.filter((r) => r.dedupeKey == null || insertedKeys.has(r.dedupeKey));
    },
    listRecent: async (serverId: string, limit = 100): Promise<EvtRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM evt WHERE server_id = $1 ORDER BY ts DESC, dedupe_key DESC, id DESC LIMIT $2", [serverId, limit]);
      return rows.map(toEvt);
    },
    query: async (q: EventQuery): Promise<EvtRow[]> => {
      const { where, args } = eventWhere(q);
      args.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
      const limitP = `$${args.length}`;
      args.push(Math.max(q.offset ?? 0, 0));
      // ts alone ties constantly — a busy server writes many events in the same second — and tied
      // rows in an unstable order would show one twice while hiding another. id breaks every tie.
      const { rows } = await this.pool.query(
        // Same tiebreak as every other evt read (dedupe_key, the line's own identity) — this one
        // is the paged query, so an order that disagreed with its siblings would page differently
        // from the way the same rows are listed anywhere else.
        `SELECT * FROM evt WHERE ${where.join(" AND ")} ORDER BY ts DESC, dedupe_key DESC, id DESC LIMIT ${limitP} OFFSET $${args.length}`,
        args,
      );
      return rows.map(toEvt);
    },
    window: async (q: EventWindowQuery): Promise<EvtRow[]> => {
      const { where, args } = eventWhere({ serverId: q.serverId, kinds: q.kinds, from: q.from, to: q.to });
      args.push(Math.max(1, Math.trunc(q.limit)));
      // The newest `limit` in the paged reads' order, handed back the other way round.
      const { rows } = await this.pool.query(
        `SELECT * FROM (SELECT * FROM evt WHERE ${where.join(" AND ")} ORDER BY ts DESC, dedupe_key DESC, id DESC LIMIT $${args.length}) w
          ORDER BY ts, dedupe_key, id`,
        args,
      );
      return rows.map(toEvt);
    },
    countQuery: async (q: EventQuery): Promise<number> => {
      const { where, args } = eventWhere(q);
      const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM evt WHERE ${where.join(" AND ")}`, args);
      return rows[0]?.n ?? 0;
    },
    listByPlayer: async (playerId: string, limit = 100, kinds?: string[], opts: { offset?: number; serverId?: string; serverIds?: string[] } = {}): Promise<EvtRow[]> => {
      const args: unknown[] = [playerId, limit, Math.max(0, opts.offset ?? 0)];
      const where = ["(actor_player_id = $1 OR victim_player_id = $1)"];
      if (kinds) { args.push(kinds); where.push(`kind = ANY($${args.length}::text[])`); }
      if (opts.serverId) { args.push(opts.serverId); where.push(`server_id = $${args.length}`); }
      // The reader's boundary, applied in SQL so it bounds the page rather than thinning it:
      // filtering rows out afterwards would hand a scoped reader 3 of 50 and call it a page.
      // `::text` rather than a uuid[] cast — the ids come from a grant list, and a malformed one
      // should narrow the read, never throw over the whole feed.
      if (opts.serverIds) { args.push(opts.serverIds); where.push(`server_id::text = ANY($${args.length}::text[])`); }
      const { rows } = await this.pool.query(
        `SELECT * FROM evt WHERE ${where.join(" AND ")} ORDER BY ts DESC, dedupe_key DESC, id DESC LIMIT $2 OFFSET $3`,
        args,
      );
      return rows.map(toEvt);
    },
    countByPlayer: async (playerId: string, kinds?: string[], serverId?: string, serverIds?: string[]): Promise<number> => {
      const args: unknown[] = [playerId];
      const where = ["(actor_player_id = $1 OR victim_player_id = $1)"];
      if (kinds) { args.push(kinds); where.push(`kind = ANY($${args.length}::text[])`); }
      if (serverId) { args.push(serverId); where.push(`server_id = $${args.length}`); }
      if (serverIds) { args.push(serverIds); where.push(`server_id::text = ANY($${args.length}::text[])`); }
      const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM evt WHERE ${where.join(" AND ")}`, args);
      return rows[0].n as number;
    },
    fillImportedTeamSwitches: async (serverId: string, rows: { dedupeKey: string; ts: string; data: Record<string, unknown> }[]): Promise<number> => {
      const mine = rows.filter((r) => r.dedupeKey.startsWith("crcon:"));
      let n = 0;
      for (let start = 0; start < mine.length; start += 1000) {
        const slice = mine.slice(start, start + 1000);
        const res = await this.pool.query(
          `UPDATE evt e SET data = v.data
           FROM unnest($2::text[], $3::timestamptz[], $4::jsonb[]) AS v(key, ts, data)
           WHERE e.server_id = $1 AND md5(e.dedupe_key)::uuid = md5(v.key)::uuid AND e.dedupe_key = v.key AND e.ts = v.ts
             AND e.kind = 'evt.player.teamSwitched' AND e.dedupe_key LIKE 'crcon:%'
             AND (e.data IS NULL OR NOT (e.data ? 'swapFrom'))
             AND e.data IS DISTINCT FROM v.data`,
          [serverId, slice.map((r) => r.dedupeKey), slice.map((r) => r.ts), slice.map((r) => JSON.stringify(r.data))],
        );
        n += res.rowCount ?? 0;
      }
      return n;
    },
    firstLocalTs: async (serverId: string): Promise<string | null> => {
      const { rows } = await this.pool.query(
        "SELECT min(ts) AS t FROM evt WHERE server_id = $1 AND (dedupe_key IS NULL OR dedupe_key NOT LIKE 'crcon:%')",
        [serverId],
      );
      return rows[0]?.t ? new Date(rows[0].t).toISOString() : null;
    },
    countForTrim: async (spec: TrimSpec): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM evt WHERE kind = ANY($1::text[]) AND ts < $2", [spec.kinds, spec.olderThanIso]);
      return rows[0].n as number;
    },
    trim: async (spec: TrimSpec): Promise<TrimResult> => {
      // Without a backup this is one statement and there is nothing to hold.
      if (!spec.backupPath) {
        const res = await this.pool.query("DELETE FROM evt WHERE kind = ANY($1::text[]) AND ts < $2", [spec.kinds, spec.olderThanIso]);
        return { deleted: res.rowCount ?? 0, backupPath: null };
      }

      /*
       * With a backup, delete in batches and write each batch as it is deleted.
       *
       * It used to SELECT the whole matched slice into memory, write it, then DELETE. Two problems,
       * both of which this shape removes:
       *
       *   - Memory grew with the size of the trim. Measured against real Postgres: 300,000 events,
       *     a fortnight on a busy server, cost 417 MB of resident memory — in the API process that
       *     is also serving the panel. This project imports YEARS of history from CRCON, so
       *     millions of rows is the expected case and the API would be OOM-killed mid-trim.
       *   - The backup was a different query from the delete. Anything matching the predicate that
       *     arrived in between — a CRCON import backfilling historical events, which is exactly the
       *     workload here — was deleted without ever being written to the file.
       *
       * `DELETE ... RETURNING` makes the backup *be* the deleted rows: no row can be removed
       * without having been handed back to write. Keyed on (id, ts), the primary key, so the
       * planner can still prune partitions.
       */
      const writer = await openBackupWriter(spec.backupPath);
      let deleted = 0;
      try {
        for (;;) {
          const { rows } = await this.pool.query(
            `WITH doomed AS (
               SELECT id, ts FROM evt WHERE kind = ANY($1::text[]) AND ts < $2 ORDER BY ts LIMIT ${TRIM_BATCH}
             )
             DELETE FROM evt USING doomed d WHERE evt.id = d.id AND evt.ts = d.ts RETURNING evt.*`,
            [spec.kinds, spec.olderThanIso],
          );
          if (rows.length === 0) break;
          await writer.write(rows.map(toEvt));
          deleted += rows.length;
        }
      } finally {
        // Close on the failure path too: a trim that dies halfway leaves a readable archive of
        // what it managed to delete, rather than a truncated gzip stream nothing can open.
        await writer.close().catch(() => {});
      }
      return { deleted, backupPath: spec.backupPath };
    },
  };

  /**
   * Per-dataset trim configuration: the table, the predicate that makes a row "aged past the
   * cutoff", and any child table a cascade would silently take with it. The child SELECT runs
   * against the same doomed set BEFORE the parent delete, so the backup file holds everything the
   * delete destroys — a cascade must never remove rows the archive has not seen.
   */
  private static TRIM_TABLES: Record<string, { table: string; where: string; order: string; children?: { table: string; join: string }[]; alongside?: { table: string; where: string; order: string }[] }> = {
    rosterSnapshots: { table: "roster_snapshots", where: "ts < $1", order: "ts" },
    playerSessions: { table: "player_sessions", where: "disconnected_at < $1", order: "disconnected_at" },
    // Only FINISHED rounds age out — the open round is live state, whenever it started.
    matches: {
      table: "matches", where: "ended_at IS NOT NULL AND ended_at < $1", order: "ended_at",
      children: [{ table: "player_match_stats", join: "match_id" }, { table: "crcon_player_stats", join: "match_id" }, { table: "match_score_series", join: "match_id" }],
      // The short rounds only the CRCON-compatible endpoints list age out with the rest.
      alongside: [{ table: "crcon_short_rounds", where: "ended_at IS NOT NULL AND ended_at < $1", order: "ended_at" }],
    },
    mapVotes: {
      table: "mapvote_history", where: "decided_at < $1", order: "decided_at",
      children: [{ table: "mapvote_ballots", join: "history_id" }],
    },
    // An admin still in camera has no exit time; their session is in progress, not history.
    adminCam: { table: "admin_cam_sessions", where: "exited_at IS NOT NULL AND exited_at < $1", order: "exited_at" },
    // last_seen predicates: an address or name seen since the cutoff stays, however old its
    // first sighting — "not seen lately" is the thing being aged out, not "known for a while".
    ipHistory: { table: "player_ips", where: "last_seen < $1", order: "last_seen" },
    aliasHistory: { table: "player_aliases", where: "last_seen < $1", order: "last_seen" },
    audit: { table: "audit", where: "ts < $1", order: "ts" },
    // …except the permanent markers: `keep:` says this row records something irreversible that
    // already happened, and collecting it by age re-arms whatever it was guarding. See
    // PERMANENT_KV_PREFIX in types.ts.
    pluginKv: { table: "plugin_kv", where: `updated_at < $1 AND key NOT LIKE '${PERMANENT_KV_PREFIX}%'`, order: "updated_at" },
  };

  trimData = {
    preview: async (datasets: string[], olderThanIso: string): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const id of datasets) {
        const cfg = PostgresRepository.TRIM_TABLES[id];
        if (!cfg) throw new Error(`unknown trim dataset: ${id}`);
        const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM ${cfg.table} WHERE ${cfg.where}`, [olderThanIso]);
        out[id] = rows[0].n as number;
      }
      return out;
    },
    run: async (datasets: string[], olderThanIso: string, backupDir: string | null): Promise<Record<string, TrimResult>> => {
      const out: Record<string, TrimResult> = {};
      for (const id of datasets) {
        const cfg = PostgresRepository.TRIM_TABLES[id];
        if (!cfg) throw new Error(`unknown trim dataset: ${id}`);
        if (!backupDir) {
          const res = await this.pool.query(`DELETE FROM ${cfg.table} WHERE ${cfg.where}`, [olderThanIso]);
          for (const a of cfg.alongside ?? []) await this.pool.query(`DELETE FROM ${a.table} WHERE ${a.where}`, [olderThanIso]);
          out[id] = { deleted: res.rowCount ?? 0, backupPath: null };
          continue;
        }
        // Same shape as the event trim, for the same two reasons: memory stays flat however big
        // the trim, and no row is removed without having been handed to the writer first. Datasets
        // with children pin each batch's ids in one SELECT and then use exactly that list for both
        // the child capture and the parent delete — computing the doomed set twice would let an
        // import backfilling old rows shift the LIMIT window between the two statements, deleting
        // a parent whose children were never archived. A crash between capture and delete leaves
        // rows archived-but-present; the re-run deletes them again, which duplicates backup lines
        // and loses nothing.
        const backupPath = `${backupDir}/trim-${id}-${Date.now()}.ndjson.gz`;
        const writer = await openBackupWriter(backupPath);
        let deleted = 0;
        try {
          for (;;) {
            let batch: Record<string, unknown>[];
            if (cfg.children?.length) {
              const doomed = await this.pool.query(
                `SELECT id FROM ${cfg.table} WHERE ${cfg.where} ORDER BY ${cfg.order} LIMIT ${TRIM_BATCH}`,
                [olderThanIso],
              );
              const ids = doomed.rows.map((r) => r.id as string);
              if (ids.length === 0) break;
              for (const child of cfg.children) {
                const { rows } = await this.pool.query(`SELECT * FROM ${child.table} WHERE ${child.join} = ANY($1::uuid[])`, [ids]);
                if (rows.length) await writer.write(rows.map((row) => ({ table: child.table, row: archivedRow(row) })));
              }
              const res = await this.pool.query(`DELETE FROM ${cfg.table} WHERE id = ANY($1::uuid[]) RETURNING *`, [ids]);
              batch = res.rows;
            } else {
              // Childless tables (some with composite keys) go through ctid in a SINGLE statement,
              // which cannot race anything: the rows deleted are the rows returned.
              const res = await this.pool.query(
                `WITH doomed AS (SELECT ctid FROM ${cfg.table} WHERE ${cfg.where} ORDER BY ${cfg.order} LIMIT ${TRIM_BATCH})
                 DELETE FROM ${cfg.table} USING doomed d WHERE ${cfg.table}.ctid = d.ctid RETURNING ${cfg.table}.*`,
                [olderThanIso],
              );
              batch = res.rows;
            }
            if (batch.length === 0) break;
            await writer.write(batch.map((row) => ({ table: cfg.table, row: archivedRow(row) })));
            deleted += batch.length;
          }
          for (const a of cfg.alongside ?? []) {
            for (;;) {
              const res = await this.pool.query(
                `WITH doomed AS (SELECT ctid FROM ${a.table} WHERE ${a.where} ORDER BY ${a.order} LIMIT ${TRIM_BATCH})
                 DELETE FROM ${a.table} USING doomed d WHERE ${a.table}.ctid = d.ctid RETURNING ${a.table}.*`,
                [olderThanIso],
              );
              if (res.rows.length === 0) break;
              await writer.write(res.rows.map((row) => ({ table: a.table, row: archivedRow(row) })));
            }
          }
        } finally {
          // As with the event trim: a run that dies halfway leaves a readable archive of what it
          // managed to delete, not a truncated gzip stream nothing can open.
          await writer.close().catch(() => {});
        }
                out[id] = { deleted, backupPath };
      }
      return out;
    },
  };

  /**
   * Whole-database export/import by DATA_EXPORT_GROUPS — see the catalog in types.ts for the
   * grouping and ordering rules. Everything here is generic over table NAMES: tables come only
   * from the catalog and columns only from information_schema, so nothing user-supplied is ever
   * spliced into SQL, and a schema change is picked up without touching this code.
   */
  dataPort = {
    supported: true,

    counts: async (groups: string[]): Promise<Record<string, number>> => {
      tablesForDataGroups(groups); // validates the ids; the walk below reuses the catalog order
      const want = new Set(groups);
      const out: Record<string, number> = {};
      for (const g of DATA_EXPORT_GROUPS) {
        if (!want.has(g.id)) continue;
        let n = 0;
        for (const table of g.tables) {
          const kept = DATA_EXPORT_ROWS_KEPT[table];
          const { rows } = await this.pool.query(`SELECT count(*)::bigint AS n FROM "${table}"${kept ? ` WHERE ${kept.where}` : ""}`);
          n += Number(rows[0].n);
        }
        out[g.id] = n;
      }
      return out;
    },

    export: async (groups: string[], path: string, onProgress?: (rows: number) => void): Promise<{ tables: Record<string, number>; rows: number }> => {
      const tables = tablesForDataGroups(groups);
      const writer = await openBackupWriter(path);
      const perTable: Record<string, number> = {};
      let total = 0;
      try {
        // `full` is computed, not claimed: an archive that covers every catalogued group IS a
        // full backup wherever it was made — the one-press button, or the migration exporter
        // with everything selected. Restore trusts this stamp (see validateFullArchive), so it
        // must be derived from the groups actually written, never from which caller asked.
        const full = DATA_EXPORT_GROUPS.every((g) => groups.includes(g.id));
        await writer.write([{ header: { format: "data-port", version: 1, exportedAt: new Date().toISOString(), groups, full } }]);
        // One cursor per table on a dedicated connection: a multi-million-row game log streams
        // through in fetch-sized slices instead of being materialized in this process.
        //
        // ONE transaction for the WHOLE archive, not one per table: the app keeps writing while
        // an export runs, and with per-table snapshots a vip granted mid-export could land in the
        // archive while the player it points at (exported seconds earlier) did not — an archive
        // that imports with refusals despite selecting every dependency. REPEATABLE READ pins a
        // single MVCC snapshot, so every table is read as of the same instant; READ ONLY because
        // this connection must never write.
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          try {
            for (const table of tables) {
              perTable[table] = 0;
              const kept = DATA_EXPORT_ROWS_KEPT[table];
              await client.query(`DECLARE data_port_cur NO SCROLL CURSOR FOR SELECT * FROM "${table}"${kept ? ` WHERE ${kept.where}` : ""}`);
              for (;;) {
                const { rows } = await client.query("FETCH 2000 FROM data_port_cur");
                if (rows.length === 0) break;
                await writer.write(rows.map((row) => ({ table, row: archivedRow(row) })));
                perTable[table] += rows.length;
                total += rows.length;
                onProgress?.(total);
              }
              await client.query("CLOSE data_port_cur");
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          }
        } finally {
          client.release();
        }
      } finally {
        await writer.close();
      }
      return { tables: perTable, rows: total };
    },

    import: async (path: string, onProgress?: (rows: number) => void, opts?: { refuseTables?: ReadonlySet<string> }): Promise<DataPortReport> => {
      const { createReadStream } = await import("node:fs");
      const { createGunzip } = await import("node:zlib");
      const { createInterface } = await import("node:readline");
      const known = new Set(DATA_EXPORT_GROUPS.flatMap((g) => g.tables));
      const report: DataPortReport = {};
      const entry = (table: string): DataPortTableReport => (report[table] ??= { read: 0, inserted: 0, skipped: 0, failed: 0 });
      let processed = 0;

      // Batches are flushed on table change, so file order decides insert order. Our own archives
      // are written parents-first (catalog order); that property is the whole FK story.
      let batchTable: string | null = null;
      let batchCols = "";
      let batch: Record<string, unknown>[] = [];
      const flush = async () => {
        if (!batchTable || batch.length === 0) { batch = []; return; }
        await this.importPortBatch(batchTable, batch, entry(batchTable));
        processed += batch.length;
        onProgress?.(processed);
        batch = [];
      };

      const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const line of rl) {
        const s = line.trim();
        if (!s) continue;
        let rec: { header?: unknown; table?: unknown; row?: unknown };
        try { rec = JSON.parse(s) as typeof rec; } catch { (report.__invalid ??= { read: 0, inserted: 0, skipped: 0, failed: 0 }).failed += 1; continue; }
        if (rec.header) continue; // provenance line — informational only
        const table = typeof rec.table === "string" ? rec.table : "";
        const row = rec.row && typeof rec.row === "object" ? (rec.row as Record<string, unknown>) : null;
        if (!row || !known.has(table)) {
          const e = entry(table || "__invalid");
          e.read += 1;
          e.failed += 1;
          e.error ??= known.has(table) ? "line carries no row object" : "not a table this app exports";
          continue;
        }
        entry(table).read += 1;
        if (opts?.refuseTables?.has(table)) {
          const e = entry(table);
          e.failed += 1;
          e.error ??= "only an owner can import accounts, roles and permissions";
          continue;
        }
        // Also flush when the column signature shifts mid-table (a hand-built archive may mix
        // shapes); one multi-row INSERT must share one column list.
        const cols = Object.keys(row).sort().join(",");
        if (table !== batchTable || cols !== batchCols || batch.length >= 1000) await flush();
        batchTable = table;
        batchCols = cols;
        batch.push(row);
      }
      await flush();
      await this.resyncPortSequences(Object.keys(report).filter((t) => known.has(t) && (report[t]?.inserted ?? 0) > 0));
      return report;
    },

    restore: async (path: string, onProgress?: (rows: number) => void): Promise<DataPortReport> => {
      /*
       * Read the WHOLE archive before touching the database. The wipe is the irreversible half of
       * a restore, and it used to run on nothing more than "a file with the right name exists" —
       * so a truncated gzip (a killed copy, a half-downloaded file), a corrupt line, or a partial
       * export renamed to look like a backup emptied the database and only then discovered there
       * was nothing whole to refill it with. Every refusal here happens while the install is
       * still exactly as it was.
       */
      await this.validateFullArchive(path);
      /*
       * Stand the worker down next. It is a separate process that keeps ingesting while this
       * runs, and its writes race the archive's — a player upserted from a live log line takes
       * that platform id with a fresh uuid, the archive's row loses the unique-index conflict,
       * and everything pointing at the archived uuid is then refused as an orphan. The marker
       * (see @app/shared restore-marker) pauses the ingest tick within one poll and stands every
       * server runner down at the next rescan; the grace wait covers the poll, so nothing is
       * mid-write when the wipe begins. Refreshed as the import progresses so a multi-hour
       * archive stays protected; cleared however this ends, so a failed restore doesn't leave
       * ingestion silenced — and its own expiry backstops even a killed process.
       */
      armRestoreMarker();
      try {
        const graceMs = Number(process.env.RESTORE_GRACE_MS ?? 12_000);
        if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
        // Children first: the reverse of the order the archive was written in, which is the same
        // FK story read backwards. One transaction, so a wipe that fails half-way leaves the
        // database exactly as it was rather than half-emptied.
        const tables = [...tablesForDataGroups(allDataGroups())].reverse();
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          try {
            // Rows an archive never carries (DATA_EXPORT_ROWS_KEPT) are not wiped either: the
            // import could never bring them back, so wiping them would simply lose them.
            for (const table of tables) {
              const kept = DATA_EXPORT_ROWS_KEPT[table];
              await client.query(`DELETE FROM "${table}"${kept ? ` WHERE ${kept.where}` : ""}`);
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          }
        } finally {
          client.release();
        }
        let markerFreshMs = Date.now();
        return await this.dataPort.import(path, (rows) => {
          if (Date.now() - markerFreshMs > 60_000) { armRestoreMarker(); markerFreshMs = Date.now(); }
          onProgress?.(rows);
        });
      } finally {
        clearRestoreMarker();
      }
    },
  };

  /**
   * Prove an archive is a whole, readable full backup — or refuse while the database is still
   * intact. Stricter than import on purpose: import tolerates a junk line by counting it failed,
   * because import adds to a database that still exists; this pass decides whether the database
   * may be EMPTIED, and a wipe must never ride on a file that cannot fully replace what it wipes.
   */
  private async validateFullArchive(path: string): Promise<void> {
    const { createReadStream } = await import("node:fs");
    const { createGunzip } = await import("node:zlib");
    const { createInterface } = await import("node:readline");
    const known = new Set(DATA_EXPORT_GROUPS.flatMap((g) => g.tables));
    let sawHeader = false;
    let line = 0;
    try {
      const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const raw of rl) {
        const s = raw.trim();
        if (!s) continue;
        line++;
        let rec: { header?: { format?: unknown; full?: unknown }; table?: unknown; row?: unknown };
        try { rec = JSON.parse(s) as typeof rec; } catch { throw new Error(`line ${line} is not JSON — the archive is corrupt`); }
        if (line === 1) {
          if (!rec.header || rec.header.format !== "data-port") {
            throw new Error("this file does not carry a data-port header — it was not made by the backup or export tools");
          }
          if (rec.header.full !== true) {
            throw new Error("this archive is a PARTIAL export, not a full backup — restoring it would wipe everything and bring back only a slice. Use Import to add its rows instead.");
          }
          sawHeader = true;
          continue;
        }
        if (typeof rec.table !== "string" || !known.has(rec.table) || !rec.row || typeof rec.row !== "object") {
          throw new Error(`line ${line} is not a row of any table this app exports — the archive is corrupt or hand-edited`);
        }
      }
    } catch (err) {
      // A gunzip error (truncated or not-gzip) surfaces here too; whatever the cause, one shape
      // of answer: why this file may not replace the database.
      throw new Error(`refusing to restore: ${(err as Error).message}`, { cause: err });
    }
    if (!sawHeader) throw new Error("refusing to restore: the archive is empty");
  }

  /** Columns per table with their types, from information_schema — the whitelist every inserted
   *  column runs through, and how each value is handed to it. */
  private portColumns = new Map<string, Map<string, string>>();
  private async portTableColumns(table: string): Promise<Map<string, string>> {
    const cached = this.portColumns.get(table);
    if (cached) return cached;
    const { rows } = await this.pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]);
    const cols = new Map<string, string>(rows.map((r) => [r.column_name as string, r.data_type as string]));
    this.portColumns.set(table, cols);
    return cols;
  }

  /** Insert one same-shape batch: conflicts are skips (existing data always wins), and a batch the
   *  database refuses is retried row-by-row so one bad row costs one row, not a thousand. */
  private async importPortBatch(table: string, rows: Record<string, unknown>[], rep: DataPortTableReport): Promise<void> {
    const tableCols = await this.portTableColumns(table);
    const cols = Object.keys(rows[0]!).filter((c) => tableCols.has(c));
    if (cols.length === 0) {
      rep.failed += rows.length;
      rep.error ??= "no column in these rows matches the table";
      return;
    }
    // A list for an array column (match_score_series.points) goes over as a list, which the driver
    // writes as a Postgres array. Any other object or list is a json payload: stringified for
    // Postgres to cast, exactly how the app's own writes pass jsonb. Bytes arrive as their text
    // form (archivedRow) and need nothing.
    const val = (c: string, v: unknown) => (v !== null && typeof v === "object" && tableCols.get(c) !== "ARRAY" ? JSON.stringify(v) : v);
    const colSql = cols.map((c) => `"${c}"`).join(", ");
    const insertRows = async (slice: Record<string, unknown>[]): Promise<number> => {
      const params: unknown[] = [];
      const tuples = slice.map((row) => `(${cols.map((c) => { params.push(val(c, row[c])); return `$${params.length}`; }).join(", ")})`);
      const res = await this.pool.query(`INSERT INTO "${table}" (${colSql}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`, params);
      return res.rowCount ?? 0;
    };
    try {
      const inserted = await insertRows(rows);
      rep.inserted += inserted;
      rep.skipped += rows.length - inserted;
    } catch {
      for (const row of rows) {
        try {
          const inserted = await insertRows([row]);
          rep.inserted += inserted;
          rep.skipped += 1 - inserted;
        } catch (err) {
          rep.failed += 1;
          rep.error ??= (err as Error).message;
        }
      }
    }
  }

  /** After inserting explicit ids into serial columns, move each sequence past the new max so the
   *  next organic insert doesn't collide with an imported row. */
  private async resyncPortSequences(tables: string[]): Promise<void> {
    for (const table of tables) {
      const { rows } = await this.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_default LIKE 'nextval(%'`, [table]);
      for (const r of rows) {
        const col = r.column_name as string;
        await this.pool.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max("${col}") FROM "${table}"), 0) + 1, false)`,
          [table, col]);
      }
    }
  }

  sessions = {
    open: async (playerId: string, serverId: string, ts: string): Promise<number> => {
      /*
       * A second connect with no disconnect between BANKS the first session; it does not
       * overwrite it.
       *
       * `DO UPDATE SET connected_at` moved the start forward and threw the earlier interval away
       * with no row anywhere to show for it. The game does not always send a disconnect — a
       * server restart sends none at all — so a player who rejoined quickly, before the roster
       * reaper's next successful read could notice they were gone, lost their entire evening:
       * no player_sessions row, no playtime on their career, and nothing under a payout window
       * that asks who was present. Silent, and unbounded in how much it discarded.
       *
       * The new connect is the honest end for the old session: they were here from the old start
       * and gone by the time they connected again, so the overstatement is at most the length of
       * whatever gap nobody observed — minutes for a restart — against losing every hour before
       * it. Clamped at zero, and the unique index on (player, server, connected_at) makes a
       * replayed pair a no-op.
       *
       * A connect at or BEFORE the open session's start is old news arriving late, not a new
       * session: the row already describes something newer, so it is left exactly as it is.
       *
       * The overstatement is bounded at a day (SESSION_MAX_SEC): a connect weeks after the last
       * one, with no disconnect between, banks a day from the old start — never the weeks.
       */
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `DELETE FROM open_sessions
            WHERE player_id = $1 AND server_id = $2 AND connected_at < $3::timestamptz
            RETURNING connected_at, EXTRACT(EPOCH FROM ($3::timestamptz - connected_at)) AS secs,
                      LEAST($3::timestamptz, connected_at + make_interval(secs => ${SESSION_MAX_SEC})) AS ended_at`,
          [playerId, serverId, ts],
        );
        let banked = 0;
        if (rows[0]) {
          const durationSec = Math.min(SESSION_MAX_SEC, Math.max(0, Math.round(Number(rows[0].secs))));
          const done = await client.query(
            `INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (player_id, server_id, connected_at) DO NOTHING`,
            [randomUUID(), playerId, serverId, rows[0].connected_at, rows[0].ended_at, durationSec],
          );
          // Only what this call actually recorded is credited — a replay whose row already exists
          // inserts nothing, and must not add the same minutes to a career a second time.
          if (done.rowCount) banked = durationSec;
        }
        await client.query(
          `INSERT INTO open_sessions (player_id, server_id, connected_at) VALUES ($1,$2,$3)
           ON CONFLICT (player_id, server_id) DO NOTHING`,
          [playerId, serverId, ts],
        );
        await client.query("COMMIT");
        return banked;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: async (playerId: string, serverId: string, ts: string): Promise<number> => {
      // Capped at a day from the connect (SESSION_MAX_SEC): a disconnect that closes a session
      // opened days ago is the end of one whose real end nobody saw.
      const { rows } = await this.pool.query(
        `DELETE FROM open_sessions WHERE player_id = $1 AND server_id = $2
         RETURNING connected_at, EXTRACT(EPOCH FROM ($3::timestamptz - connected_at)) AS secs,
                   LEAST($3::timestamptz, connected_at + make_interval(secs => ${SESSION_MAX_SEC})) AS ended_at`,
        [playerId, serverId, ts],
      );
      if (!rows[0]) return 0; // no open session — nothing to close or record
      const durationSec = Math.min(SESSION_MAX_SEC, Math.max(0, Math.round(Number(rows[0].secs))));
      await this.pool.query(
        `INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (player_id, server_id, connected_at) DO NOTHING`,
        [randomUUID(), playerId, serverId, rows[0].connected_at, rows[0].ended_at, durationSec],
      );
      return durationSec;
    },
    list: async (playerId: string, limit = 50, serverId?: string): Promise<PlayerSessionRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM player_sessions WHERE player_id = $1${serverId ? " AND server_id = $3" : ""}
          ORDER BY disconnected_at DESC, id DESC LIMIT $2`,
        serverId ? [playerId, limit, serverId] : [playerId, limit],
      );
      return rows.map(toSession);
    },
    inWindow: async (serverId: string, fromIso: string, toIso: string): Promise<{ playerId: string; connectedAt: string; disconnectedAt: string }[]> => {
      // Overlap, not containment — a session wrapped around the window still counts; the payout
      // engine clips it to the window (windowMinutes in @app/payout).
      const { rows } = await this.pool.query(
        `SELECT player_id, connected_at, disconnected_at FROM player_sessions
          WHERE server_id = $1 AND connected_at < $3 AND disconnected_at > $2
          ORDER BY connected_at, player_id`,
        [serverId, fromIso, toIso],
      );
      return rows.map((r: any) => ({
        playerId: r.player_id,
        connectedAt: new Date(r.connected_at).toISOString(),
        disconnectedAt: new Date(r.disconnected_at).toISOString(),
      }));
    },
    openServers: async (playerId: string): Promise<string[]> => {
      const { rows } = await this.pool.query("SELECT server_id FROM open_sessions WHERE player_id = $1", [playerId]);
      return rows.map((r: any) => r.server_id);
    },
    latestFor: async (playerIds: string[]): Promise<Map<string, { connectedAt: string; disconnectedAt: string | null }>> => {
      const out = new Map<string, { connectedAt: string; disconnectedAt: string | null }>();
      if (!playerIds.length) return out;
      // One indexed probe per player: the newest open session and the most recently ended one.
      const { rows } = await this.pool.query(
        `SELECT p.id AS player_id, o.connected_at AS open_at, c.connected_at AS closed_at, c.disconnected_at
           FROM unnest($1::uuid[]) AS p(id)
           LEFT JOIN LATERAL (SELECT connected_at FROM open_sessions WHERE player_id = p.id ORDER BY connected_at DESC LIMIT 1) o ON true
           LEFT JOIN LATERAL (SELECT connected_at, disconnected_at FROM player_sessions WHERE player_id = p.id ORDER BY disconnected_at DESC LIMIT 1) c ON true`,
        [playerIds],
      );
      for (const r of rows as any[]) {
        const open = r.open_at ? new Date(r.open_at).toISOString() : null;
        const closed = r.closed_at ? new Date(r.closed_at).toISOString() : null;
        if (open && (!closed || open >= closed)) out.set(r.player_id, { connectedAt: open, disconnectedAt: null });
        else if (closed) out.set(r.player_id, { connectedAt: closed, disconnectedAt: new Date(r.disconnected_at).toISOString() });
      }
      return out;
    },
    openServersFor: async (playerIds: string[]): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>();
      if (!playerIds.length) return out;
      const { rows } = await this.pool.query("SELECT player_id, server_id FROM open_sessions WHERE player_id = ANY($1)", [playerIds]);
      for (const r of rows as any[]) out.set(r.player_id, [...(out.get(r.player_id) ?? []), r.server_id]);
      return out;
    },
    openOnServer: async (serverId: string): Promise<Map<string, string>> => {
      const { rows } = await this.pool.query("SELECT player_id, connected_at FROM open_sessions WHERE server_id = $1", [serverId]);
      return new Map((rows as any[]).map((r) => [r.player_id as string, new Date(r.connected_at).toISOString()]));
    },
    closeAbsent: async (serverId: string, presentPlayerIds: string[], connectedBeforeIso: string, ts: string): Promise<number> => {
      // One statement decides: the rows deleted are exactly the rows recorded, same as close().
      // `NOT (= ANY($3))` over an empty roster is every session — an empty server is a valid
      // roster and precisely the case after a crash stranded the whole lobby.
      const { rows } = await this.pool.query(
        `DELETE FROM open_sessions
          WHERE server_id = $1 AND connected_at < $2 AND NOT (player_id = ANY($3::uuid[]))
          RETURNING player_id, connected_at, LEAST(${SESSION_MAX_SEC}, GREATEST(0, ROUND(EXTRACT(EPOCH FROM ($4::timestamptz - connected_at)))))::int AS secs`,
        [serverId, connectedBeforeIso, presentPlayerIds, ts],
      );
      for (const r of rows as any[]) {
        await this.pool.query(
          // GREATEST in SQL, not a comparison in JS: the reaper's end is capped at the last time
          // anything observed the server (see the worker's session-reap), which for a session that
          // STARTED during the blind spot can be earlier than its own beginning. A zero-length row
          // is the honest floor; a negative one is nonsense every consumer would have to defend
          // against. (`connected_at` arrives from pg as a Date, so `ts < r.connected_at` in JS
          // compares a timestamp string against "Fri Aug 28 2026 …" and decides nothing.) And at most
          // a day from the connect, like every session (SESSION_MAX_SEC).
          `INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec)
           VALUES ($1,$2,$3,$4, LEAST(GREATEST($5::timestamptz, $4::timestamptz), $4::timestamptz + make_interval(secs => ${SESSION_MAX_SEC})), $6)
           ON CONFLICT (player_id, server_id, connected_at) DO NOTHING`,
          [randomUUID(), r.player_id, serverId, r.connected_at, ts, Number(r.secs)],
        );
      }
      return rows.length;
    },
    importOne: async (input: { playerId: string; serverId: string; connectedAt: string; disconnectedAt: string; durationSec: number }): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        `INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (player_id, server_id, connected_at) DO NOTHING`,
        [randomUUID(), input.playerId, input.serverId, input.connectedAt, input.disconnectedAt, input.durationSec],
      );
      return (rowCount ?? 0) > 0;
    },
    importMany: async (rows: ImportedSession[]): Promise<ImportedSession[]> => {
      // Deduped on the same key the constraint uses, so the RETURNING set maps 1:1 back to inputs.
      const merged = new Map<string, ImportedSession>();
      for (const r of rows) {
        if (!r.playerId || !r.serverId || !r.connectedAt) continue;
        merged.set(`${r.playerId}\u0000${r.serverId}\u0000${Date.parse(r.connectedAt)}`, r);
      }
      if (merged.size === 0) return [];
      const vals: unknown[] = [];
      // Sorted for consistent lock order across concurrent flushes (deadlock prevention).
      const tuples = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r], n) => {
        vals.push(randomUUID(), r.playerId, r.serverId, r.connectedAt, r.disconnectedAt, r.durationSec);
        const b = n * 6;
        return `($${b + 1}::uuid,$${b + 2}::uuid,$${b + 3}::uuid,$${b + 4}::timestamptz,$${b + 5}::timestamptz,$${b + 6}::int)`;
      });
      const { rows: got } = await this.pool.query<{ player_id: string; server_id: string; connected_at: Date }>(
        `INSERT INTO player_sessions (id, player_id, server_id, connected_at, disconnected_at, duration_sec)
         SELECT id, player_id, server_id, connected_at, disconnected_at, duration_sec
         FROM (VALUES ${tuples.join(",")}) AS v(id, player_id, server_id, connected_at, disconnected_at, duration_sec)
         ON CONFLICT (player_id, server_id, connected_at) DO NOTHING
         RETURNING player_id, server_id, connected_at`,
        vals,
      );
      // Matched back by EPOCH, not by text: RETURNING cannot carry a source-only ordinal, and the
      // driver's Date rendering need not equal the caller's ISO string byte for byte. The key is
      // the same one the map was built with, so this stays a hash lookup per returned row.
      const out: ImportedSession[] = [];
      for (const g of got) {
        const hit = merged.get(`${g.player_id}\u0000${g.server_id}\u0000${new Date(g.connected_at).getTime()}`);
        if (hit) out.push(hit);
      }
      return out;
    },
  };

  stats = {
    bump: async (playerId: string, serverId: string, delta: StatsDelta): Promise<void> => {
      await this.stats.bumpMany([{ playerId, serverId, delta }]);
    },
    bumpMany: async (deltas: { playerId: string; serverId: string; delta: StatsDelta }[]): Promise<void> => {
      // One VALUES list, whatever the batch. Duplicated (player, server) pairs are summed here
      // rather than left to the statement: ON CONFLICT DO UPDATE refuses to touch one row twice.
      const merged = new Map<string, { playerId: string; serverId: string } & Required<StatsDelta>>();
      for (const { playerId, serverId, delta } of deltas) {
        if (!playerId || !serverId) continue;
        const key = `${playerId}\u0000${serverId}`;
        const cur = merged.get(key) ?? { playerId, serverId, kills: 0, deaths: 0, teamkills: 0, visits: 0, playtimeSec: 0 };
        cur.kills += delta.kills ?? 0;
        cur.deaths += delta.deaths ?? 0;
        cur.teamkills += delta.teamkills ?? 0;
        cur.visits += delta.visits ?? 0;
        cur.playtimeSec += delta.playtimeSec ?? 0;
        merged.set(key, cur);
      }
      if (merged.size === 0) return;
      const vals: unknown[] = [];
      // Sorted for consistent lock order across concurrent flushes (deadlock prevention).
      const tuples = [...merged.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, d], n) => {
        vals.push(d.playerId, d.serverId, d.kills, d.deaths, d.teamkills, d.visits, d.playtimeSec);
        const b = n * 7;
        return `($${b + 1}::uuid,$${b + 2}::uuid,$${b + 3}::int,$${b + 4}::int,$${b + 5}::int,$${b + 6}::int,$${b + 7}::bigint)`;
      });
      await this.pool.query(
        `INSERT INTO player_stats (player_id, server_id, kills, deaths, teamkills, visits, playtime_sec, updated_at)
         SELECT player_id, server_id, kills, deaths, teamkills, visits, playtime_sec, now()
         FROM (VALUES ${tuples.join(",")}) AS v(player_id, server_id, kills, deaths, teamkills, visits, playtime_sec)
         ON CONFLICT (player_id, server_id) DO UPDATE SET
           kills = player_stats.kills + EXCLUDED.kills,
           deaths = player_stats.deaths + EXCLUDED.deaths,
           teamkills = player_stats.teamkills + EXCLUDED.teamkills,
           visits = player_stats.visits + EXCLUDED.visits,
           playtime_sec = player_stats.playtime_sec + EXCLUDED.playtime_sec,
           updated_at = now()`,
        vals,
      );
    },
    settlePlaytimeFromSessions: async (serverId: string, beforeTs: string | null): Promise<number> => {
      // Raise-only: the DO UPDATE fires solely when the recorded history exceeds the rollup, so a
      // rollup already carrying live-era seconds on top of its folded history is never lowered,
      // and running this twice is a no-op the second time.
      const { rowCount } = await this.pool.query(
        `INSERT INTO player_stats (player_id, server_id, playtime_sec)
         SELECT player_id, server_id, COALESCE(SUM(duration_sec), 0)::bigint
           FROM player_sessions
          WHERE server_id = $1 AND ($2::timestamptz IS NULL OR disconnected_at < $2::timestamptz)
          GROUP BY player_id, server_id
         ON CONFLICT (player_id, server_id) DO UPDATE SET
           playtime_sec = EXCLUDED.playtime_sec, updated_at = now()
         WHERE player_stats.playtime_sec < EXCLUDED.playtime_sec`,
        [serverId, beforeTs],
      );
      return rowCount ?? 0;
    },
    get: async (playerId: string, serverId?: string): Promise<PlayerStatsRow | null> => {
      if (serverId) {
        const { rows } = await this.pool.query("SELECT * FROM player_stats WHERE player_id = $1 AND server_id = $2", [playerId, serverId]);
        return rows[0] ? toPlayerStats(rows[0]) : null;
      }
      // No server named: the career, which is every server's rows folded together. The counters
      // add; highest_level takes the max because a level is a high-water mark, not a total; and
      // role_seconds merges key by key. Returned with server_id null, which is what says "this is
      // a total, not a server's figures" to everything downstream.
      const { rows } = await this.pool.query(
        `SELECT player_id, NULL::uuid AS server_id,
                sum(kills)::int AS kills, sum(deaths)::int AS deaths, sum(teamkills)::int AS teamkills,
                sum(visits)::int AS visits, sum(playtime_sec)::bigint AS playtime_sec,
                sum(combat)::bigint AS combat, sum(offense)::bigint AS offense,
                sum(defense)::bigint AS defense, sum(support)::bigint AS support,
                sum(vehicle_kills)::bigint AS vehicle_kills, sum(vehicles_destroyed)::bigint AS vehicles_destroyed,
                sum(sl_seconds)::bigint AS sl_seconds, max(highest_level)::int AS highest_level,
                sum(matches_played)::int AS matches_played, sum(matches_won)::int AS matches_won,
                max(updated_at) AS updated_at,
                (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
                   SELECT e.key AS k, sum((e.value)::bigint) AS v
                   FROM player_stats x, jsonb_each_text(x.role_seconds) e
                   WHERE x.player_id = $1
                   GROUP BY e.key
                 ) agg) AS role_seconds
         FROM player_stats WHERE player_id = $1
         GROUP BY player_id`,
        [playerId],
      );
      return rows[0] ? toPlayerStats(rows[0]) : null;
    },
    byServer: async (playerId: string): Promise<PlayerStatsRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM player_stats WHERE player_id = $1 ORDER BY updated_at DESC", [playerId],
      );
      return rows.map(toPlayerStats);
    },
    playtimeFor: async (playerIds: string[], opts: { serverId: string | null; since: string | null }): Promise<Map<string, number>> => {
      if (!playerIds.length) return new Map();
      const { rows } = opts.since === null
        ? await this.pool.query(
          `SELECT player_id, sum(playtime_sec)::bigint AS sec FROM player_stats
            WHERE player_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR server_id = $2::uuid) GROUP BY player_id`,
          [playerIds, opts.serverId],
        )
        // Only the part of each session after the bound counts; the (player_id, disconnected_at)
        // index serves the range for a whole roster.
        : await this.pool.query(
          `SELECT player_id, sum(GREATEST(0, LEAST(duration_sec, EXTRACT(EPOCH FROM (disconnected_at - $2::timestamptz)))))::bigint AS sec
             FROM player_sessions
            WHERE player_id = ANY($1::uuid[]) AND disconnected_at > $2::timestamptz AND ($3::uuid IS NULL OR server_id = $3::uuid)
            GROUP BY player_id`,
          [playerIds, opts.since, opts.serverId],
        );
      return new Map((rows as { player_id: string; sec: string }[]).map((r) => [r.player_id, Number(r.sec)]));
    },
    visitsFor: async (playerIds: string[], serverId: string): Promise<Map<string, { visits: number; playtimeSec: number }>> => {
      if (!playerIds.length) return new Map();
      const { rows } = await this.pool.query(
        "SELECT player_id, visits, playtime_sec FROM player_stats WHERE server_id = $1 AND player_id = ANY($2::uuid[])",
        [serverId, playerIds],
      );
      return new Map((rows as any[]).map((r) => [r.player_id as string, { visits: Number(r.visits), playtimeSec: Number(r.playtime_sec) }]));
    },
    sampleRoster: async (input: { serverId: string; matchId: string | null; sampleSec: number; players: RosterSampleRow[] }): Promise<void> => {
      // One row per platform id, last wins — the game's roster can list a player twice around a
      // reconnect, and a duplicated key in one VALUES batch is "ON CONFLICT DO UPDATE command
      // cannot affect row a second time" (seen in production, killing the whole sample). Sorted so
      // concurrent samples lock rows in the same order instead of deadlocking.
      const byPlatform = new Map<string, RosterSampleRow>();
      for (const p of input.players) if (p.platformId) byPlatform.set(p.platformId, p);
      const rows = [...byPlatform.values()].sort((a, b) => a.platformId < b.platformId ? -1 : 1);
      if (rows.length === 0) return;
      const sec = Math.max(0, Math.round(input.sampleSec));

      // One statement, whatever the roster size. Everything below keys off a VALUES list joined to
      // players, so a 100-player server costs the same round trips as an empty one.
      const vals: unknown[] = [];
      const tuples = rows.map((p, i) => {
        const b = i * 14;
        vals.push(
          p.platformId,
          p.role == null ? null : String(p.role),
          p.isSquadLead ? sec : 0,
          Math.max(0, Math.round(p.level ?? 0)),
          Math.max(0, Math.round(p.score?.combat ?? 0)),
          Math.max(0, Math.round(p.score?.offense ?? 0)),
          Math.max(0, Math.round(p.score?.defense ?? 0)),
          Math.max(0, Math.round(p.score?.support ?? 0)),
          Math.max(0, Math.round(p.score?.vehicleKills ?? 0)),
          Math.max(0, Math.round(p.score?.vehiclesDestroyed ?? 0)),
          // The GAME's own counters, which are not the kill stream's — see RosterSampleRow.
          Math.max(0, Math.round(p.score?.killsAndAssists ?? 0)),
          Math.max(0, Math.round(p.score?.deathsAndRedeploys ?? 0)),
          // The unit triple, as the ints CRCON republishes. Side maps to HLL's own stable team ids
          // (allies 1, axis 2, unknown 0) — the same pair both games use, per docs/streamer-mode.md.
          p.side === "allies" ? 1 : p.side === "axis" ? 2 : 0,
          p.squad == null ? -1 : Math.round(p.squad),
        );
        return `($${b + 1}::text, $${b + 2}::text, $${b + 3}::int, $${b + 4}::int, $${b + 5}::int, $${b + 6}::int, $${b + 7}::int, $${b + 8}::int, $${b + 9}::int, $${b + 10}::int, $${b + 11}::int, $${b + 12}::int, $${b + 13}::int, $${b + 14}::int)`;
      }).join(",");

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Career rollup FIRST, while player_match_stats still holds the previous sample's figures.
        // Score adds only the INCREASE over those, which is what makes replaying a sample a no-op
        // rather than a double count. With no open match there is nothing to diff against, so score
        // is left alone and only the clocks move.
        //
        // And score moves only once the open round has run MIN_MATCH_MS (`mt.ripe`). The game keeps
        // showing the last round's scoreboard between rounds, and a round opened on the end screen
        // (a start line the game writes there, a round restarted seconds in) diffed that whole
        // scoreboard against its empty lines and added every player's last round to their career a
        // second time — then ended as a "0m" round. Until the round is ripe its lines still fill
        // (the live scoreboard is right from the first minute) but careers wait; the first ripe
        // sample diffs against nothing (`mt.credited` still false) and so brings the round's first
        // minutes in whole, and from then on the lines are the baseline again.
        const delta = (col: string, line: string) =>
          `CASE WHEN mt.ripe THEN GREATEST(s.${col} - CASE WHEN mt.credited THEN coalesce(m.${line}, 0) ELSE 0 END, 0) ELSE 0 END`;
        await client.query(
          `WITH s(platform_id, role, sl_sec, level, combat, offense, defense, support, vk, vd, ka, dr, team, squad) AS (VALUES ${tuples}),
                mt AS (
                  SELECT started_at <= now() - interval '${MIN_MATCH_MS / 1000} seconds' AS ripe, scores_credited AS credited
                  FROM matches WHERE id = $${rows.length * 14 + 1}::uuid
                ),
                j AS (
                  SELECT p.id AS player_id, s.role, s.sl_sec, s.level,
                         ${delta("combat", "combat")} AS d_combat,
                         ${delta("offense", "offense")} AS d_offense,
                         ${delta("defense", "defense")} AS d_defense,
                         ${delta("support", "support")} AS d_support,
                         ${delta("vk", "vehicle_kills")} AS d_vk,
                         ${delta("vd", "vehicles_destroyed")} AS d_vd
                  FROM s
                  JOIN players p ON p.platform_id = s.platform_id
                  LEFT JOIN mt ON true
                  LEFT JOIN player_match_stats m
                    ON m.player_id = p.id AND m.match_id = $${rows.length * 14 + 1}::uuid
                )
           INSERT INTO player_stats (player_id, server_id, combat, offense, defense, support, vehicle_kills, vehicles_destroyed,
                                     role_seconds, sl_seconds, highest_level, updated_at)
           SELECT j.player_id, $${rows.length * 14 + 3}::uuid, j.d_combat, j.d_offense, j.d_defense, j.d_support, j.d_vk, j.d_vd,
                  CASE WHEN j.role IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(j.role, $${rows.length * 14 + 2}::int) END,
                  j.sl_sec, j.level, now()
           FROM j
           ON CONFLICT (player_id, server_id) DO UPDATE SET
             combat = player_stats.combat + EXCLUDED.combat,
             offense = player_stats.offense + EXCLUDED.offense,
             defense = player_stats.defense + EXCLUDED.defense,
             support = player_stats.support + EXCLUDED.support,
             vehicle_kills = player_stats.vehicle_kills + EXCLUDED.vehicle_kills,
             vehicles_destroyed = player_stats.vehicles_destroyed + EXCLUDED.vehicles_destroyed,
             role_seconds = player_stats.role_seconds ||
               (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
                  SELECT k, (coalesce((player_stats.role_seconds ->> k)::bigint, 0) + (e.value)::bigint) AS v
                  FROM jsonb_each_text(EXCLUDED.role_seconds) e(k, value)
                ) q),
             sl_seconds = player_stats.sl_seconds + EXCLUDED.sl_seconds,
             highest_level = GREATEST(player_stats.highest_level, EXCLUDED.highest_level),
             updated_at = now()`,
          // The score gate is `mt`, and it is not decoration. With no open match there is nothing to
          // diff the sample against: `mt` is empty, so every score delta is 0 — ungated, the LEFT
          // JOIN finding no match line made each delta the FULL running scoreboard, which the game
          // keeps showing between rounds, and a server sitting between matches added every player's
          // entire last-round score to their career once a minute, forever.
          [...vals, input.matchId, sec, input.serverId],
        );
        // The round's first ripe sample has now brought its scores in whole: from here on the
        // match lines are the baseline (the same transaction's now(), so this agrees with `mt`).
        if (input.matchId) {
          await client.query(
            `UPDATE matches SET scores_credited = true
             WHERE id = $1 AND NOT scores_credited AND started_at <= now() - interval '${MIN_MATCH_MS / 1000} seconds'`,
            [input.matchId],
          );
        }
        // The match line SECOND. Order matters and is the whole trick: the career step above diffs
        // the sample against what the match line held BEFORE this sample, so raising the match line
        // first would make every delta zero. Max-wins here because the game reports the round's
        // running total and a value can only climb within a round — summing samples would multiply
        // every score by however many times we happened to poll.
        if (input.matchId) {
          await client.query(
            `WITH s(platform_id, role, sl_sec, level, combat, offense, defense, support, vk, vd, ka, dr, team, squad) AS (VALUES ${tuples})
             INSERT INTO player_match_stats (match_id, player_id, server_id, combat, offense, defense, support,
                                             vehicle_kills, vehicles_destroyed, role_seconds, sl_seconds,
                                             kills_and_assists, deaths_and_redeploys, units, updated_at)
             SELECT $${rows.length * 14 + 1}::uuid, p.id, $${rows.length * 14 + 2}::uuid,
                    s.combat, s.offense, s.defense, s.support, s.vk, s.vd,
                    CASE WHEN s.role IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(s.role, $${rows.length * 14 + 3}::int) END,
                    s.sl_sec, s.ka, s.dr,
                    -- The unit leg this sample observed, timestamped from the round's own start so
                    -- ts means what CRCON's does: seconds since kickoff, not since the sample.
                    jsonb_build_array(jsonb_build_object(
                      'ts', GREATEST(0, EXTRACT(EPOCH FROM (now() - mt.started_at))::int),
                      'team', s.team, 'squad', s.squad,
                      'role', coalesce(s.role::int, -1))),
                    now()
             FROM s
             JOIN players p ON p.platform_id = s.platform_id
             CROSS JOIN (SELECT started_at FROM matches WHERE id = $${rows.length * 14 + 1}::uuid) mt
             ON CONFLICT (match_id, player_id) DO UPDATE SET
               combat = GREATEST(player_match_stats.combat, EXCLUDED.combat),
               offense = GREATEST(player_match_stats.offense, EXCLUDED.offense),
               defense = GREATEST(player_match_stats.defense, EXCLUDED.defense),
               support = GREATEST(player_match_stats.support, EXCLUDED.support),
               vehicle_kills = GREATEST(player_match_stats.vehicle_kills, EXCLUDED.vehicle_kills),
               vehicles_destroyed = GREATEST(player_match_stats.vehicles_destroyed, EXCLUDED.vehicles_destroyed),
               -- Role clocks ADD: they measure time observed, not a running total the game reports.
               role_seconds = jsonb_strip_nulls(
                 player_match_stats.role_seconds ||
                 (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
                    SELECT k, (coalesce((player_match_stats.role_seconds ->> k)::int, 0) + (e.value)::int) AS v
                    FROM jsonb_each_text(EXCLUDED.role_seconds) e(k, value)
                  ) q)),
               sl_seconds = player_match_stats.sl_seconds + EXCLUDED.sl_seconds,
               -- The game's own counters reset when a player reconnects mid-round, so a value that
               -- went DOWN is a new session rather than a correction: bank the old total in _prev
               -- and start counting again. Every right-hand side here reads the pre-update row, so
               -- _prev is computed from the value the next line replaces. Same two-part accounting
               -- as CRCON's p_kills_and_assists.
               kills_and_assists_prev = CASE
                 WHEN EXCLUDED.kills_and_assists < player_match_stats.kills_and_assists
                   THEN player_match_stats.kills_and_assists_prev + player_match_stats.kills_and_assists
                 ELSE player_match_stats.kills_and_assists_prev END,
               kills_and_assists = EXCLUDED.kills_and_assists,
               deaths_and_redeploys_prev = CASE
                 WHEN EXCLUDED.deaths_and_redeploys < player_match_stats.deaths_and_redeploys
                   THEN player_match_stats.deaths_and_redeploys_prev + player_match_stats.deaths_and_redeploys
                 ELSE player_match_stats.deaths_and_redeploys_prev END,
               deaths_and_redeploys = EXCLUDED.deaths_and_redeploys,
               -- Append a unit leg ONLY when the triple changed, which is what makes this a history
               -- rather than one entry per poll. CRCON diffs against its cached p_unit; the stored
               -- array's last element is the same thing.
               units = CASE WHEN (
                      (player_match_stats.units -> -1 ->> 'team')::int  IS DISTINCT FROM (EXCLUDED.units -> 0 ->> 'team')::int
                   OR (player_match_stats.units -> -1 ->> 'squad')::int IS DISTINCT FROM (EXCLUDED.units -> 0 ->> 'squad')::int
                   OR (player_match_stats.units -> -1 ->> 'role')::int  IS DISTINCT FROM (EXCLUDED.units -> 0 ->> 'role')::int
                 ) THEN player_match_stats.units || EXCLUDED.units
                 ELSE player_match_stats.units END,
               updated_at = now()`,
            [...vals, input.matchId, input.serverId, sec],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    settleMatch: async (matchId: string, winner: "allies" | "axis" | null): Promise<void> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // present_at_end is set from the final roster; everyone else on the line played but left.
        await client.query(
          `UPDATE player_match_stats m SET
             present_at_end = EXISTS (
               SELECT 1 FROM open_sessions o WHERE o.player_id = m.player_id AND o.server_id = m.server_id
             ),
             won = CASE WHEN $2::text IS NULL OR m.side IS NULL THEN NULL ELSE (m.side = $2::text) END,
             updated_at = now()
           WHERE m.match_id = $1::uuid`,
          [matchId, winner],
        );
        // Roll played/won onto careers. Guarded by settled_at so closing twice cannot double-count:
        // the UPDATE above is idempotent, this one would not be. (settled_at is a real column;
        // it used to be a ' settled' marker appended to result — text the panel shows verbatim.)
        const { rows: already } = await client.query(
          "SELECT 1 FROM matches WHERE id = $1::uuid AND settled_at IS NOT NULL", [matchId],
        );
        if (already.length === 0) {
          await client.query(
            // The match line already carries the server the round was played on, so played/won
            // land on that server's career row rather than a merged one. A round that ended before
            // the sampler's first ripe sample (see MIN_MATCH_MS) never had its scores credited:
            // they come in now, from the lines, so a game is never left out of a career.
            `INSERT INTO player_stats (player_id, server_id, matches_played, matches_won,
                                       combat, offense, defense, support, vehicle_kills, vehicles_destroyed, updated_at)
             SELECT m.player_id, m.server_id, 1, CASE WHEN m.won THEN 1 ELSE 0 END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.combat END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.offense END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.defense END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.support END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.vehicle_kills END,
                    CASE WHEN mt.scores_credited THEN 0 ELSE m.vehicles_destroyed END,
                    now()
             FROM player_match_stats m JOIN matches mt ON mt.id = m.match_id
             WHERE m.match_id = $1::uuid
             ON CONFLICT (player_id, server_id) DO UPDATE SET
               matches_played = player_stats.matches_played + EXCLUDED.matches_played,
               matches_won = player_stats.matches_won + EXCLUDED.matches_won,
               combat = player_stats.combat + EXCLUDED.combat,
               offense = player_stats.offense + EXCLUDED.offense,
               defense = player_stats.defense + EXCLUDED.defense,
               support = player_stats.support + EXCLUDED.support,
               vehicle_kills = player_stats.vehicle_kills + EXCLUDED.vehicle_kills,
               vehicles_destroyed = player_stats.vehicles_destroyed + EXCLUDED.vehicles_destroyed,
               updated_at = now()`,
            [matchId],
          );
          await client.query("UPDATE matches SET settled_at = now(), scores_credited = true WHERE id = $1::uuid", [matchId]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    leaderboard: async (sort: LeaderboardSort, limit = 100, serverIds?: string[], offset = 0): Promise<LeaderboardEntry[]> => {
      if (serverIds?.length === 0) return [];
      const order = LEADERBOARD_ORDER[sort] ?? LEADERBOARD_ORDER.kills;
      // One line per player either way, so the sort expressions are the same for both boards —
      // the only difference is which servers' rows go into the fold. Ranking several servers
      // together is a legitimate thing to ask for; it just has to be asked for.
      //
      // One server needs no fold: the table holds one row per player and server, so that server's
      // rows ARE its lines, read in order down its (server_id, figure DESC) index until the limit.
      // Folded first, every row on the server was read to rank them (110ms on a 100k-player
      // install, 270ms as the planner chose it for a bound list) against about 1ms.
      const one = serverIds?.length === 1;
      const source = one
        ? `SELECT player_id, kills, deaths, teamkills, combat, offense, defense, support, sl_seconds, playtime_sec
             FROM player_stats WHERE server_id = $2`
        : `SELECT player_id, sum(kills)::int AS kills, sum(deaths)::int AS deaths, sum(teamkills)::int AS teamkills,
                sum(combat)::bigint AS combat, sum(offense)::bigint AS offense, sum(defense)::bigint AS defense,
                sum(support)::bigint AS support, sum(sl_seconds)::bigint AS sl_seconds,
                sum(playtime_sec)::bigint AS playtime_sec
           FROM player_stats ${serverIds ? "WHERE server_id = ANY($2)" : ""} GROUP BY player_id`;
      const { rows } = await this.pool.query(
        `SELECT ps.player_id, p.name, p.platform, ps.kills, ps.deaths, ps.teamkills,
                ps.combat, ps.offense, ps.defense, ps.support, ps.sl_seconds, ps.playtime_sec
         FROM (${source}) ps JOIN players p ON p.id = ps.player_id
         ORDER BY ${order}${LEADERBOARD_TIEBREAK} LIMIT $1 OFFSET ${one || serverIds ? "$3" : "$2"}`,
        one ? [limit, serverIds![0], offset] : serverIds ? [limit, serverIds, offset] : [limit, offset],
      );
      return rows.map((r: any) => ({
        playerId: r.player_id, name: r.name, platform: r.platform,
        kills: r.kills, deaths: r.deaths, teamkills: r.teamkills, kd: computeKd(r.kills, r.deaths),
        combat: Number(r.combat ?? 0), offense: Number(r.offense ?? 0),
        defense: Number(r.defense ?? 0), support: Number(r.support ?? 0),
        slSeconds: Number(r.sl_seconds ?? 0), playtime: Number(r.playtime_sec ?? 0),
      }));
    },
    leaderboardCount: async (serverIds?: string[]): Promise<number> => {
      if (serverIds?.length === 0) return 0;
      // A player's row references them, so every row is a line on the board: one server's rows
      // are counted as they stand, and several servers' are one line per player.
      const { rows } = serverIds?.length === 1
        ? await this.pool.query("SELECT count(*)::int AS n FROM player_stats WHERE server_id = $1", [serverIds[0]])
        : await this.pool.query(`SELECT count(DISTINCT player_id)::int AS n FROM player_stats${serverIds ? " WHERE server_id = ANY($1)" : ""}`, serverIds ? [serverIds] : []);
      return rows[0].n as number;
    },
  };

  announcements = {
    markRead: async (userId: string, announcementIds: string[]): Promise<void> => {
      if (!announcementIds.length) return;
      // Receipts only for POSTED notices; the first read time is never overwritten.
      await this.pool.query(
        `INSERT INTO announcement_reads (announcement_id, user_id)
         SELECT id, $2 FROM announcements WHERE id = ANY($1) AND published = true
         ON CONFLICT (announcement_id, user_id) DO NOTHING`,
        [announcementIds, userId],
      );
    },
    acknowledge: async (announcementId: string, userId: string): Promise<AnnouncementReadRow | null> => {
      const { rows } = await this.pool.query(
        `INSERT INTO announcement_reads (announcement_id, user_id, acknowledged_at)
         SELECT id, $2, now() FROM announcements WHERE id = $1 AND published = true
         ON CONFLICT (announcement_id, user_id) DO UPDATE SET acknowledged_at = COALESCE(announcement_reads.acknowledged_at, now())
         RETURNING *`,
        [announcementId, userId],
      );
      return rows[0] ? toAnnouncementRead(rows[0]) : null;
    },
    reads: async (announcementId: string): Promise<AnnouncementReadRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM announcement_reads WHERE announcement_id = $1 ORDER BY read_at", [announcementId]);
      return rows.map(toAnnouncementRead);
    },
    readsForUser: async (userId: string): Promise<AnnouncementReadRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM announcement_reads WHERE user_id = $1", [userId]);
      return rows.map(toAnnouncementRead);
    },
    getNudgeConfig: async (): Promise<AnnouncementNudgeConfig> => {
      const { rows } = await this.pool.query("SELECT * FROM announcement_nudge_config WHERE singleton = true");
      const r = rows[0];
      return r
        ? { enabled: r.enabled, channelId: r.channel_id, afterHours: Number(r.after_hours), excusedUserIds: (r.excused_user_ids ?? []) as string[] }
        : { ...ANNOUNCEMENT_NUDGE_DEFAULTS };
    },
    setNudgeConfig: async (patch: Partial<AnnouncementNudgeConfig>): Promise<AnnouncementNudgeConfig> => {
      const { rows } = await this.pool.query(
        `INSERT INTO announcement_nudge_config (singleton, enabled, channel_id, after_hours, excused_user_ids)
         VALUES (true, COALESCE($1, false), COALESCE($2, ''), COALESCE($3, 48), COALESCE($4::jsonb, '[]'::jsonb))
         ON CONFLICT (singleton) DO UPDATE SET
           enabled = COALESCE($1, announcement_nudge_config.enabled),
           channel_id = COALESCE($2, announcement_nudge_config.channel_id),
           after_hours = COALESCE($3, announcement_nudge_config.after_hours),
           excused_user_ids = COALESCE($4::jsonb, announcement_nudge_config.excused_user_ids),
           updated_at = now()
         RETURNING *`,
        [patch.enabled ?? null, patch.channelId ?? null, patch.afterHours ?? null, patch.excusedUserIds ? JSON.stringify(patch.excusedUserIds) : null],
      );
      const r = rows[0];
      return { enabled: r.enabled, channelId: r.channel_id, afterHours: Number(r.after_hours), excusedUserIds: (r.excused_user_ids ?? []) as string[] };
    },
    markNudged: async (id: string): Promise<void> => {
      await this.pool.query("UPDATE announcements SET nudged_at = now() WHERE id = $1", [id]);
    },
    create: async (input: NewAnnouncement): Promise<AnnouncementRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO announcements (id, title, body, published, published_at, author_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [randomUUID(), input.title, input.body, input.published ?? false, input.published ? new Date().toISOString() : null, input.authorUserId ?? null],
      );
      return toAnnouncement(rows[0]);
    },
    listPublished: async (limit = 50, offset = 0) => {
      const { rows } = await this.pool.query("SELECT * FROM announcements WHERE published = true ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2", [limit, offset]);
      return rows.map(toAnnouncement);
    },
    countPublished: async () => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM announcements WHERE published = true");
      return rows[0].n as number;
    },
    listAll: async (limit = 100, offset = 0) => {
      const { rows } = await this.pool.query("SELECT * FROM announcements ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2", [limit, offset]);
      return rows.map(toAnnouncement);
    },
    countAll: async () => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM announcements");
      return rows[0].n as number;
    },
    get: async (id: string) => {
      const { rows } = await this.pool.query("SELECT * FROM announcements WHERE id = $1", [id]);
      return rows[0] ? toAnnouncement(rows[0]) : null;
    },
    update: async (id: string, patch: AnnouncementPatch): Promise<AnnouncementRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE announcements SET
           title = COALESCE($2, title),
           body = COALESCE($3, body),
           published = COALESCE($4, published),
           -- every draft→posted transition re-anchors time-to-see at the moment of posting
           published_at = CASE WHEN $4 = true AND published = false THEN now() ELSE published_at END,
           -- …and earns a fresh nudge cycle
           nudged_at = CASE WHEN $4 = true AND published = false THEN NULL ELSE nudged_at END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.title ?? null, patch.body ?? null, patch.published ?? null],
      );
      return rows[0] ? toAnnouncement(rows[0]) : null;
    },
    remove: async (id: string) => {
      const res = await this.pool.query("DELETE FROM announcements WHERE id = $1", [id]);
      return (res.rowCount ?? 0) > 0;
    },
  };

  templates = {
    list: async (kind?: string): Promise<MessageTemplateRow[]> => {
      const { rows } = kind
        ? await this.pool.query("SELECT * FROM message_templates WHERE kind = $1 ORDER BY sort_order, updated_at", [kind])
        : await this.pool.query("SELECT * FROM message_templates ORDER BY kind, sort_order, updated_at");
      return rows.map(toTemplate);
    },
    create: async (input: NewMessageTemplate): Promise<MessageTemplateRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO message_templates (id, kind, title, body, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [randomUUID(), input.kind, input.title ?? "", input.body, input.sortOrder ?? 0],
      );
      return toTemplate(rows[0]);
    },
    update: async (id: string, patch: MessageTemplatePatch): Promise<MessageTemplateRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE message_templates SET
           kind = COALESCE($2, kind), title = COALESCE($3, title), body = COALESCE($4, body),
           sort_order = COALESCE($5, sort_order), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.kind ?? null, patch.title ?? null, patch.body ?? null, patch.sortOrder ?? null],
      );
      return rows[0] ? toTemplate(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const res = await this.pool.query("DELETE FROM message_templates WHERE id = $1", [id]);
      return (res.rowCount ?? 0) > 0;
    },
  };

  vipPresets = {
    list: async (): Promise<VipPresetRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM vip_presets ORDER BY kind, sort_order, label");
      return rows.map(toVipPreset);
    },
    create: async (input: NewVipPreset): Promise<VipPresetRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO vip_presets (id, kind, label, days, hours, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [randomUUID(), input.kind, input.label, input.days, input.hours, input.sortOrder ?? 0],
      );
      return toVipPreset(rows[0]);
    },
    update: async (id: string, patch: VipPresetPatch): Promise<VipPresetRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE vip_presets SET
           label = COALESCE($2, label), days = COALESCE($3, days), hours = COALESCE($4, hours),
           sort_order = COALESCE($5, sort_order)
         WHERE id = $1 RETURNING *`,
        [id, patch.label ?? null, patch.days ?? null, patch.hours ?? null, patch.sortOrder ?? null],
      );
      return rows[0] ? toVipPreset(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const res = await this.pool.query("DELETE FROM vip_presets WHERE id = $1", [id]);
      return (res.rowCount ?? 0) > 0;
    },
  };

  analytics = {
    sessionActivity: async (q: AnalyticsWindow): Promise<SessionActivity> => {
      const args: unknown[] = [q.from, q.to];
      let where = "connected_at >= $1 AND connected_at < $2";
      if (q.serverId) {
        args.push(q.serverId);
        where += ` AND server_id = $${args.length}`;
      }
      // Hour and day buckets are taken in the caller's zone, not the database server's. Only the
      // queries that BUCKET need it, so the zone is a separate arg list rather than a sixth
      // parameter every query has to carry.
      const tzArgs = [...args, q.tz ?? "UTC"];
      const tzP = `$${tzArgs.length}`;
      // One pass per shape rather than one giant query: each is an index-friendly aggregate, and
      // keeping them apart means a slow one is obvious instead of hidden inside a join.
      const [buckets, daily, totals, quantiles, byMap] = await Promise.all([
        this.pool.query(
          `SELECT extract(hour from connected_at AT TIME ZONE ${tzP})::int AS h,
                  extract(dow  from connected_at AT TIME ZONE ${tzP})::int AS d, count(*)::int AS n
           FROM player_sessions WHERE ${where} GROUP BY 1, 2`, tzArgs),
        this.pool.query(
          `SELECT to_char(date_trunc('day', connected_at AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date,
                  count(*)::int AS sessions, count(DISTINCT player_id)::int AS players,
                  coalesce(sum(duration_sec), 0)::bigint AS seconds
           FROM player_sessions WHERE ${where} GROUP BY 1 ORDER BY 1`, tzArgs),
        this.pool.query(
          `SELECT count(*)::int AS sessions, count(DISTINCT player_id)::int AS players,
                  coalesce(sum(duration_sec), 0)::bigint AS seconds
           FROM player_sessions WHERE ${where}`, args),
        this.pool.query(
          `SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_sec), 0)::int AS median,
                  coalesce(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_sec), 0)::int AS p90,
                  count(*) FILTER (WHERE duration_sec < ${SHORT_SESSION_SEC})::int AS short
           FROM player_sessions WHERE ${where}`, args),
        /*
         * Which map was running when they joined. History: this was first an unbounded range
         * join, then one indexed probe per window session (below), now one range per round. The old join (`matches m JOIN sessions ON
         * connected_at BETWEEN started_at AND ended_at`) had no bound on the matches side, so
         * each session's probe walked back through the whole match history: measured at 315
         * SECONDS for a 7-day window on a year of imported data, which is the analytics page
         * timing out — and it could also land one session on TWO maps at once, because the one
         * stale never-ended round the unique index permits overlaps everything after it, quietly
         * inflating the early-leaver counts. The lateral takes the latest round STARTED before
         * the join (one descent of the (server_id, started_at) index) and only credits it if it was still
         * running; a session in the gap between rounds is honestly 'Unknown', and each session
         * lands on exactly one map. Same window, 315s → milliseconds.
         */
        //
        // Driven from the ROUNDS now, which is the same answer read the other way round: a round
        // owns the joins from its start until it ended or the next one started, whichever came
        // first — exactly "the latest round started before the join, if it was still running".
        // One index range per round (a few thousand a year) instead of one descent per session
        // (hundreds of thousands); whatever no round owns is 'Unknown', by subtraction.
        this.pool.query(
          `WITH r AS (
             SELECT server_id, map, started_at,
                    least(coalesce(ended_at, 'infinity'::timestamptz),
                          coalesce(lead(started_at) OVER (PARTITION BY server_id ORDER BY started_at), 'infinity'::timestamptz)) AS until
             FROM matches WHERE started_at < $2${q.serverId ? " AND server_id = $3" : ""}
           ), mapped AS (
             SELECT r.map, count(*)::int AS sessions,
                    count(*) FILTER (WHERE s.duration_sec < ${SHORT_SESSION_SEC})::int AS short
             FROM r JOIN player_sessions s
               ON s.server_id = r.server_id
              AND s.connected_at >= greatest(r.started_at, $1::timestamptz)
              AND s.connected_at < least(r.until, $2::timestamptz)
             WHERE r.until > $1
             GROUP BY r.map
           ), tot AS (
             SELECT count(*)::int AS sessions, count(*) FILTER (WHERE duration_sec < ${SHORT_SESSION_SEC})::int AS short
             FROM player_sessions WHERE ${where}
           ), rows AS (
             SELECT map, sessions, short FROM mapped
             UNION ALL
             SELECT 'Unknown', tot.sessions - coalesce((SELECT sum(sessions) FROM mapped), 0)::int,
                    tot.short - coalesce((SELECT sum(short) FROM mapped), 0)::int FROM tot
           )
           SELECT map, sum(sessions)::int AS sessions, sum(short)::int AS short
           FROM rows GROUP BY map HAVING sum(sessions) > 0 ORDER BY sessions DESC`, args),
      ]);
      const byHour = Array<number>(24).fill(0);
      const byDow = Array<number>(7).fill(0);
      const weekHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      for (const r of buckets.rows) {
        byHour[r.h] = (byHour[r.h] ?? 0) + r.n;
        byDow[r.d] = (byDow[r.d] ?? 0) + r.n;
        const row = weekHour[r.d];
        if (row) row[r.h] = (row[r.h] ?? 0) + r.n;
      }
      const t = totals.rows[0] ?? {};
      return {
        byHour, byDow, weekHour,
        daily: daily.rows.map((r: any) => ({ date: r.date, sessions: r.sessions, players: r.players, seconds: Number(r.seconds) })),
        sessions: t.sessions ?? 0,
        uniquePlayers: t.players ?? 0,
        totalSeconds: Number(t.seconds ?? 0),
        medianSec: quantiles.rows[0]?.median ?? 0,
        p90Sec: quantiles.rows[0]?.p90 ?? 0,
        shortSessions: quantiles.rows[0]?.short ?? 0,
        shortCutoffSec: SHORT_SESSION_SEC,
        earlyLeaversByMap: byMap.rows.map((r: any) => ({ map: r.map, sessions: r.sessions, short: r.short })),
      };
    },
    platformBreakdown: async (q: AnalyticsWindow): Promise<PlatformBreakdown> => {
      // Two grouped scans, merged by platform: presence (sessions) and performance (finished
      // rounds). Kept separate because their windows are different facts — a session is placed
      // by its connect, a round by its start — and one join would multiply rows.
      const scope = q.serverId ? "AND s.server_id = $3" : "";
      const mScope = q.serverId ? "AND st.server_id = $3" : "";
      const args = q.serverId ? [q.from, q.to, q.serverId] : [q.from, q.to];
      const [sess, match] = await Promise.all([
        // New players are the scoped player mix's: active here in the window, first seen in it.
        this.pool.query(
          `SELECT p.platform, ${PLATFORM_SESSION_SUMS("p.first_seen >= $1")}
           FROM player_sessions s JOIN players p ON p.id = s.player_id
           WHERE s.connected_at >= $1 AND s.connected_at < $2 ${scope}
           GROUP BY p.platform`, args),
        this.pool.query(
          `SELECT p.platform, ${PLATFORM_ROUND_SUMS}
           FROM player_match_stats st
           JOIN matches m ON m.id = st.match_id
           JOIN players p ON p.id = st.player_id
           WHERE m.ended_at IS NOT NULL AND m.started_at >= $1 AND m.started_at < $2 ${mScope}
           GROUP BY p.platform`, args),
      ]);
      const byPlatform = new Map<string, PlatformBreakdown["rows"][number]>();
      const at = (platform: string) => {
        const row = byPlatform.get(platform) ?? { platform, ...emptyPlatformSums() };
        byPlatform.set(platform, row);
        return row;
      };
      for (const r of sess.rows) foldPlatformSessions(at(r.platform ?? "unknown"), r);
      for (const r of match.rows) foldPlatformRounds(at(r.platform ?? "unknown"), r);
      return { rows: [...byPlatform.values()].sort((a, b) => b.players - a.players || b.kills - a.kills || a.platform.localeCompare(b.platform)) };
    },
    platformTrend: async (q: AnalyticsWindow): Promise<PlatformTrend> => {
      // The breakdown's two grouped scans with the LOCAL day added to the key — the same day
      // bucketing as sessionActivity's daily trend, so the charts on the page agree about which
      // day a midnight join is.
      const args: unknown[] = [q.from, q.to];
      let sWhere = "s.connected_at >= $1 AND s.connected_at < $2";
      let mWhere = "m.ended_at IS NOT NULL AND m.started_at >= $1 AND m.started_at < $2";
      if (q.serverId) {
        args.push(q.serverId);
        sWhere += ` AND s.server_id = $${args.length}`;
        mWhere += ` AND st.server_id = $${args.length}`;
      }
      args.push(q.tz ?? "UTC");
      const tzP = `$${args.length}`;
      const [sess, match, firsts] = await Promise.all([
        // A day's new players are the ones first seen THAT local day — the same zone and the same
        // midnight as the day they are counted under.
        this.pool.query(
          `SELECT to_char(date_trunc('day', s.connected_at AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date,
                  p.platform, ${PLATFORM_SESSION_SUMS(`date_trunc('day', p.first_seen AT TIME ZONE ${tzP}) = date_trunc('day', s.connected_at AT TIME ZONE ${tzP})`)}
           FROM player_sessions s JOIN players p ON p.id = s.player_id
           WHERE ${sWhere} GROUP BY 1, 2`, args),
        this.pool.query(
          `SELECT to_char(date_trunc('day', m.started_at AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date,
                  p.platform, ${PLATFORM_ROUND_SUMS}
           FROM player_match_stats st
           JOIN matches m ON m.id = st.match_id
           JOIN players p ON p.id = st.player_id
           WHERE ${mWhere} GROUP BY 1, 2`, args),
        // Each player once, on the day of their first session in the window: what a running count
        // of players adds up. New is the breakdown's rule (first seen in the window), so the two
        // running counts end at the table's players and new players.
        this.pool.query(
          `SELECT to_char(date_trunc('day', f.first_at AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date, p.platform,
                  count(*)::int AS first_players,
                  count(*) FILTER (WHERE p.first_seen >= $1)::int AS first_new_players
           FROM (SELECT s.player_id, min(s.connected_at) AS first_at FROM player_sessions s WHERE ${sWhere} GROUP BY s.player_id) f
           JOIN players p ON p.id = f.player_id
           GROUP BY 1, 2`, args),
      ]);
      const byKey = new Map<string, PlatformTrend["rows"][number]>();
      const at = (date: string, platform: string) => {
        const key = `${date}|${platform}`;
        const row = byKey.get(key) ?? emptyPlatformTrendRow(date, platform);
        byKey.set(key, row);
        return row;
      };
      for (const r of sess.rows) foldPlatformSessions(at(r.date, r.platform ?? "unknown"), r);
      for (const r of match.rows) foldPlatformRounds(at(r.date, r.platform ?? "unknown"), r);
      for (const r of firsts.rows) {
        const row = at(r.date, r.platform ?? "unknown");
        row.firstPlayers = Number(r.first_players);
        row.firstNewPlayers = Number(r.first_new_players);
      }
      return { rows: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)) };
    },
    playerMix: async (q: AnalyticsWindow): Promise<PlayerMix> => {
      // Scoped by a server means "players who had a session on it in the window"; unscoped uses
      // the players table's own seen-window, which spans every server.
      const { rows } = q.serverId
        ? await this.pool.query(
            `WITH active AS (
               SELECT DISTINCT s.player_id FROM player_sessions s
               WHERE s.server_id = $3 AND s.connected_at >= $1 AND s.connected_at < $2
             )
             SELECT count(*) FILTER (WHERE p.first_seen >= $1) ::int AS new_players,
                    count(*) FILTER (WHERE p.first_seen <  $1) ::int AS returning_players,
                    count(*) FILTER (WHERE p.first_seen >= $1 AND p.last_seen > p.first_seen + interval '1 day') ::int AS came_back
             FROM players p JOIN active a ON a.player_id = p.id`,
            [q.from, q.to, q.serverId])
        : await this.pool.query(
            `SELECT count(*) FILTER (WHERE first_seen >= $1) ::int AS new_players,
                    count(*) FILTER (WHERE first_seen <  $1) ::int AS returning_players,
                    count(*) FILTER (WHERE first_seen >= $1 AND last_seen > first_seen + interval '1 day') ::int AS came_back
             FROM players WHERE last_seen >= $1 AND last_seen < $2`,
            [q.from, q.to]);
      const r = rows[0] ?? {};
      return { newPlayers: r.new_players ?? 0, returningPlayers: r.returning_players ?? 0, newPlayersWhoCameBack: r.came_back ?? 0 };
    },
    matchesInWindow: async (q: AnalyticsWindow): Promise<MatchRow[]> => {
      const args: unknown[] = [q.from, q.to];
      let where = "started_at >= $1 AND started_at < $2";
      if (q.serverId) { args.push(q.serverId); where += ` AND server_id = $${args.length}`; }
      const { rows } = await this.pool.query(
        `SELECT * FROM matches WHERE ${where} AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 2000`, args);
      return rows.map(toMatch);
    },
    concurrency: async (q: AnalyticsWindow): Promise<Concurrency> => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      const step = occupancySampleSec(days);
      const args: unknown[] = [q.from, q.to];
      // Overlap, not containment: a session that started before the window and ended inside it was
      // still players on the server during it. Testing `connected_at BETWEEN from AND to` would
      // drop exactly the long sessions that matter most to a busyness figure.
      let where = "connected_at < $2 AND disconnected_at > $1";
      let openWhere = "connected_at < $2";
      if (q.serverId) {
        args.push(q.serverId);
        where += ` AND server_id = $${args.length}`;
        openWhere += ` AND server_id = $${args.length}`;
      }
      // Every session clipped to the window, plus the ones still open — which count as online
      // right up to the window's end, or the near edge is short by everyone currently playing.
      //
      // Two evidence rules, both from the field (a 100-slot server "held" 1,294 at once):
      //  - A span is believed for at most TORN_SESSION_SEC from its connect. A backlog of stale
      //    open sessions mass-closed at one instant writes multi-week "sessions", and counting
      //    them paints a phantom crowd across the whole window. Same 12h rule as the import.
      //  - Presence is per PLAYER, not per session row: one person's overlapping rows (live
      //    tracking plus an imported copy of the same evening) is still one person on the server.
      //    Occupancy counts DISTINCT players per instant; peak and the exact mean merge each
      //    player's overlapping spans first.
      const spans = `
        SELECT * FROM (
          SELECT player_id,
                 greatest(connected_at, $1::timestamptz) AS a,
                 least(disconnected_at, connected_at + make_interval(secs => ${TORN_SESSION_SEC}), $2::timestamptz) AS b
          FROM player_sessions WHERE ${where}
          UNION ALL
          SELECT player_id,
                 greatest(connected_at, $1::timestamptz),
                 least(connected_at + make_interval(secs => ${TORN_SESSION_SEC}), $2::timestamptz)
          FROM open_sessions WHERE ${openWhere}
        ) sp WHERE b > a`;
      const [samples, open, measuredQ, measuredMaxQ] = await Promise.all([
        // Occupancy, one scan: each span emits the sample instants it covers, and the DISTINCT
        // players per instant IS the number online then. Instants are aligned to the epoch so
        // they match the grid the memory store walks.
        this.pool.query(
          `SELECT g.t AS t, count(DISTINCT s.player_id)::int AS c
           FROM (${spans}) s,
                LATERAL generate_series(
                  to_timestamp(ceil(extract(epoch FROM s.a) / ${step}) * ${step}),
                  s.b - interval '1 microsecond',
                  make_interval(secs => ${step})) g(t)
           GROUP BY 1`, args),
        // Its own arg list: this query has no use for `from`, and Postgres refuses to plan a
        // statement carrying a parameter it never references ("could not determine data type").
        // Distinct players, and only rows younger than the torn cap: an open session from days
        // ago is a missed disconnect, not somebody online.
        q.serverId
          ? this.pool.query(
              `SELECT count(DISTINCT player_id)::int AS n FROM open_sessions
               WHERE connected_at < $1 AND connected_at >= $1::timestamptz - make_interval(secs => ${TORN_SESSION_SEC}) AND server_id = $2`,
              [q.to, q.serverId])
          : this.pool.query(
              `SELECT count(DISTINCT player_id)::int AS n FROM open_sessions
               WHERE connected_at < $1 AND connected_at >= $1::timestamptz - make_interval(secs => ${TORN_SESSION_SEC})`,
              [q.to]),
        // MEASURED concurrency: the worker samples the live roster about once a minute, and a
        // measurement outranks anything reconstructed from session rows. Downsampled to the
        // grid's buckets (earliest sample per server per bucket, summed across servers when
        // unscoped) — the same floor-on-the-epoch rule composition uses.
        this.pool.query(
          `WITH s AS (
             SELECT DISTINCT ON (server_id, floor(extract(epoch FROM ts) / ${step}))
                    server_id, floor(extract(epoch FROM ts) / ${step})::bigint AS k, player_count
             FROM roster_snapshots
             WHERE ts >= $1 AND ts < $2${q.serverId ? " AND server_id = $3" : ""}
             ORDER BY server_id, floor(extract(epoch FROM ts) / ${step}), ts)
           SELECT k, sum(player_count)::int AS c FROM s GROUP BY k`, args),
        // The measured peak, at full sample resolution. Only meaningful scoped: unscoped, one
        // snapshot is one server's count, not the fleet's at that instant — there the bucket
        // sums above stand in.
        q.serverId
          ? this.pool.query(
              `SELECT player_count::int AS c, ts FROM roster_snapshots
               WHERE ts >= $1 AND ts < $2 AND server_id = $3
               ORDER BY player_count DESC, ts LIMIT 1`, args)
          : Promise.resolve({ rows: [] as { c: number; ts: string }[] }),
      ]);

      const inferred = new Map<number, number>();
      for (const r of samples.rows) inferred.set(new Date(r.t).getTime(), r.c);
      const measured = new Map<number, number>();
      for (const r of measuredQ.rows) measured.set(Number(r.k) * step * 1000, Number(r.c));
      const mmRow = measuredMaxQ.rows[0];
      const blend = blendMeasuredConcurrency({
        from: q.from, to: q.to, stepSec: step,
        inferred,
        measured,
        measuredMax: mmRow ? { c: Number(mmRow.c), at: new Date(mmRow.ts).toISOString() } : null,
        inferredCap: q.serverId ? GAME_SLOT_CAP : null,
      });
      return {
        ...foldOccupancy(q, step, blend.counts, q.tz),
        peak: blend.peak,
        peakAt: blend.peakAt,
        average: blend.average,
        sampleSec: step,
        openAtEnd: open.rows[0]?.n ?? 0,
      };
    },
    earliest: async (serverId?: string): Promise<string | null> => {
      // One ordered index probe per SERVER per table, not a min() over the table: none of these
      // has an index on the timestamp alone, and a bare min(ts) over a 17M-row event log is a full
      // scan. Every one of them does have (server_id, time), which answers "the first row for this
      // server" in one descent. Retired servers count — their history is still history.
      const scope = serverId ? "WHERE s.id = $1" : "";
      const args = serverId ? [serverId] : [];
      const { rows } = await this.pool.query(
        `SELECT min(t) AS t FROM (
           SELECT (SELECT connected_at FROM player_sessions WHERE server_id = s.id ORDER BY connected_at LIMIT 1) AS t FROM servers s ${scope}
           UNION ALL SELECT (SELECT started_at FROM matches WHERE server_id = s.id ORDER BY started_at LIMIT 1) FROM servers s ${scope}
           UNION ALL SELECT (SELECT ts FROM roster_snapshots WHERE server_id = s.id ORDER BY ts LIMIT 1) FROM servers s ${scope}
           UNION ALL SELECT (SELECT ts FROM evt WHERE server_id = s.id ORDER BY ts LIMIT 1) FROM servers s ${scope}
           ${serverId ? "" : "UNION ALL SELECT (SELECT ts FROM audit ORDER BY ts LIMIT 1)"}
         ) x`,
        args,
      );
      const t = rows[0]?.t;
      return t ? new Date(t).toISOString() : null;
    },
    composition: async (q: AnalyticsWindow): Promise<RosterComposition> => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      const step = occupancySampleSec(days);
      const args: unknown[] = [q.from, q.to];
      let where = "ts >= $1 AND ts < $2";
      if (q.serverId) { args.push(q.serverId); where += ` AND server_id = $${args.length}`; }
      // Only samples taken on the game the server runs NOW.
      //
      // The caller labels this fold with one role vocabulary — the server's current descriptor —
      // and a role number means different things in different games (13 is Commander in HLL and
      // Mortar Support in Vietnam). A server that changed games therefore had its older samples
      // relabelled into a vocabulary they were never counted in, and both games' samples summed
      // into one distribution where the same key meant two roles. Excluding them keeps the
      // numbers and the labels describing the same thing; NULL is a pre-migration row, which
      // predates any switch and is treated as the server's own game, exactly as the backfill did.
      where += " AND (game IS NULL OR game = (SELECT s.game FROM servers s WHERE s.id = roster_snapshots.server_id))";
      // One snapshot per bucket, the earliest in each: DISTINCT ON does the downsampling in the
      // database, so a month-long window returns ~1,400 rows instead of 43,000. Buckets are floored
      // on the epoch, the same grid the memory store builds, or the two stores would pick different
      // snapshots and quietly disagree.
      // Keyed by server too: with no server filter every server must still be represented, and its
      // samples stay separate rather than being summed with another server's — see RosterComposition.
      const { rows } = await this.pool.query(
        `SELECT DISTINCT ON (server_id, floor(extract(epoch FROM ts) / ${step}))
                id, server_id, game, ts, player_count, composition, map_name, game_mode
         FROM roster_snapshots WHERE ${where}
         ORDER BY server_id, floor(extract(epoch FROM ts) / ${step}), ts`, args);
      // DISTINCT ON forces its own ORDER BY; the fold wants time order.
      const sampled = rows
        .map((r): RosterSnapshotRow => ({
          id: String(r.id), serverId: r.server_id, game: r.game ?? null, ts: new Date(r.ts).toISOString(),
          playerCount: r.player_count, composition: unpackComposition(r.composition),
          mapName: r.map_name ?? null, gameMode: r.game_mode ?? null,
        }))
        .sort((a, b) => a.ts.localeCompare(b.ts));
      return foldComposition(sampled, step);
    },
    hourGrid: async (q: AnalyticsWindow & { serverId: string }, metric: HourMetric): Promise<DateHourRow[]> => {
      const tz = q.tz ?? "UTC";
      const args: unknown[] = [q.from, q.to, q.serverId, tz];
      // The local date and hour every query here buckets by: the key localHourKey builds for the
      // memory store.
      const cell = (col: string) => `to_char(${col} AT TIME ZONE $4, 'YYYY-MM-DD') AS d, extract(hour FROM ${col} AT TIME ZONE $4)::int AS h`;
      const snaps = "FROM roster_snapshots WHERE server_id = $3 AND ts >= $1 AND ts < $2";
      // One side's figure in either spelling a sample is stored in: {bySide: {allies: {players}}}
      // as written before the packing, {b: {allies: [players, ...]}} since (compact-json.ts).
      const field = (side: string, f: (typeof PACKED_SIDE_FIELDS)[number]) =>
        `COALESCE(composition #> '{bySide,${side},${f}}', composition #> '{b,${side},${PACKED_SIDE_FIELDS.indexOf(f)}}')`;
      // A count the sample holds, or NULL where it holds none (or something that is not a number);
      // a list's length, or 0. The same reading the memory store makes of the same composition.
      const num = (v: string) => `CASE WHEN jsonb_typeof(${v}) = 'number' THEN (${v} #>> '{}')::numeric END`;
      const len = (v: string) => `CASE WHEN jsonb_typeof(${v}) = 'array' THEN jsonb_array_length(${v}) ELSE 0 END`;
      const sided = "(jsonb_typeof(composition #> '{bySide,allies}') = 'object' OR jsonb_typeof(composition #> '{bySide,axis}') = 'object'"
        + " OR jsonb_typeof(composition #> '{b,allies}') = 'array' OR jsonb_typeof(composition #> '{b,axis}') = 'array')";
      const cells = new Map<string, number>();
      // Per-sample figures averaged per hour. Sums and counts come back whole; hourAverage divides
      // and rounds, so the two stores agree to the decimal.
      const averaged = async (perSample: string, only = "TRUE"): Promise<DateHourRow[]> => {
        const { rows } = await this.pool.query(
          `SELECT d, h, sum(v)::float8 AS s, count(*)::int AS n
             FROM (SELECT ${cell("ts")}, ${perSample} AS v ${snaps} AND ${only}) x
            WHERE v IS NOT NULL GROUP BY 1, 2`, args);
        for (const r of rows) cells.set(`${r.d}|${r.h}`, hourAverage(Number(r.s), Number(r.n)));
        return foldHourGrid(q, tz, cells);
      };
      // Rows counted per hour, beside the hours the app sampled the roster in: where it was
      // watching, an hour with none is a real zero.
      const counted = async (sql: string, extra: unknown[] = []): Promise<DateHourRow[]> => {
        const [found, seen] = await Promise.all([
          this.pool.query(sql, [...args, ...extra]),
          this.pool.query(`SELECT DISTINCT ${cell("ts")} ${snaps}`, args),
        ]);
        for (const r of found.rows) cells.set(`${r.d}|${r.h}`, Number(r.v));
        return foldHourGrid(q, tz, cells, new Set(seen.rows.map((r: { d: string; h: number }) => `${r.d}|${r.h}`)));
      };
      switch (metric) {
        case "peak": {
          const { rows } = await this.pool.query(`SELECT ${cell("ts")}, max(player_count)::int AS v ${snaps} GROUP BY 1, 2`, args);
          for (const r of rows) cells.set(`${r.d}|${r.h}`, Number(r.v));
          return foldHourGrid(q, tz, cells);
        }
        case "queue": return averaged("queue_count + coalesce(vip_queue_count, 0)");
        case "imbalance": return averaged(`abs((${num(field("allies", "players"))}) - (${num(field("axis", "players"))}))`);
        case "noLeader": return averaged(`${len(field("allies", "noSlSquads"))} + ${len(field("axis", "noSlSquads"))}`, sided);
        case "unsquadded": return averaged(`coalesce(${num(field("allies", "unsquadded"))}, 0) + coalesce(${num(field("axis", "unsquadded"))}, 0)`, sided);
        case "arrivals":
          return counted(`SELECT ${cell("connected_at")}, count(*)::int AS v FROM player_sessions
                          WHERE server_id = $3 AND connected_at >= $1 AND connected_at < $2 GROUP BY 1, 2`);
        default:
          return counted(`SELECT ${cell("ts")}, count(*)::int AS v FROM evt
                          WHERE server_id = $3 AND ts >= $1 AND ts < $2 AND kind = ANY($5::text[]) GROUP BY 1, 2`,
            [HOUR_METRIC_KINDS[metric] ?? []]);
      }
    },
    scoreTrends: async (q: AnalyticsWindow): Promise<ScoreTrends> => {
      // Driven from `matches` (hundreds of rows in a window) into player_match_stats, not the other
      // way: the stat table has a row per player per round, so leading with it would scan far more
      // than the window needs.
      const args: unknown[] = [q.from, q.to];
      let where = "m.started_at >= $1 AND m.started_at < $2";
      if (q.serverId) { args.push(q.serverId); where += ` AND m.server_id = $${args.length}`; }
      args.push(q.tz ?? "UTC");
      const tzP = `$${args.length}`;
      const [daily, totals] = await Promise.all([
        this.pool.query(
          `SELECT to_char(date_trunc('day', m.started_at AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date,
                  count(DISTINCT m.id)::int AS rounds,
                  count(DISTINCT s.player_id)::int AS players,
                  coalesce(sum(s.combat), 0)::bigint  AS combat,
                  coalesce(sum(s.offense), 0)::bigint AS offense,
                  coalesce(sum(s.defense), 0)::bigint AS defense,
                  coalesce(sum(s.support), 0)::bigint AS support,
                  coalesce(sum(s.sl_seconds), 0)::bigint AS sl_seconds,
                  coalesce(sum(s.vehicle_kills), 0)::bigint AS vehicle_kills
             FROM matches m JOIN player_match_stats s ON s.match_id = m.id
            WHERE ${where} GROUP BY 1 ORDER BY 1`, args),
        this.pool.query(
          `SELECT count(DISTINCT m.id)::int AS rounds,
                  count(DISTINCT s.player_id)::int AS players,
                  count(DISTINCT s.player_id) FILTER (WHERE s.sl_seconds > 0)::int AS led,
                  coalesce(sum(s.combat), 0)::bigint  AS combat,
                  coalesce(sum(s.offense), 0)::bigint AS offense,
                  coalesce(sum(s.defense), 0)::bigint AS defense,
                  coalesce(sum(s.support), 0)::bigint AS support,
                  coalesce(sum(s.sl_seconds), 0)::bigint AS sl_seconds,
                  coalesce(sum(s.vehicle_kills), 0)::bigint AS vehicle_kills
             FROM matches m JOIN player_match_stats s ON s.match_id = m.id
            WHERE ${where}`, args.slice(0, args.length - 1)),
      ]);
      const t = totals.rows[0] ?? {};
      const players = Number(t.players ?? 0);
      return {
        daily: daily.rows.map((r) => ({
          date: String(r.date), rounds: Number(r.rounds), players: Number(r.players),
          combat: Number(r.combat), offense: Number(r.offense), defense: Number(r.defense),
          support: Number(r.support), slSeconds: Number(r.sl_seconds), vehicleKills: Number(r.vehicle_kills),
        })),
        totals: {
          rounds: Number(t.rounds ?? 0), players,
          combat: Number(t.combat ?? 0), offense: Number(t.offense ?? 0),
          defense: Number(t.defense ?? 0), support: Number(t.support ?? 0),
          slSeconds: Number(t.sl_seconds ?? 0), vehicleKills: Number(t.vehicle_kills ?? 0),
          ledShare: players > 0 ? Number(t.led ?? 0) / players : null,
        },
      };
    },
    combat: async (q: AnalyticsWindow): Promise<CombatActivity> => {
      const args: unknown[] = [q.from, q.to];
      let where = "e.ts >= $1 AND e.ts < $2 AND e.kind IN ('evt.kill','evt.teamkill')";
      if (q.serverId) { args.push(q.serverId); where += ` AND e.server_id = $${args.length}`; }
      const tzArgs = [...args, q.tz ?? "UTC"];
      const tzP = `$${tzArgs.length}`;
      // One grouped pass per shape, all of them index-friendly on (server_id, ts). The kill log is
      // the biggest table we have, so nothing here returns rows the API would then have to count.
      const [weapons, daily, buckets, killers, tkers, maps, totals] = await Promise.all([
        this.pool.query(
          `SELECT coalesce(nullif(e.weapon,''), 'Unknown') AS weapon, e.kind, count(*)::int AS n
           FROM evt e WHERE ${where} GROUP BY 1, 2`, args),
        this.pool.query(
          `SELECT to_char(date_trunc('day', e.ts AT TIME ZONE ${tzP}), 'YYYY-MM-DD') AS date, e.kind, count(*)::int AS n
           FROM evt e WHERE ${where} GROUP BY 1, 2 ORDER BY 1`, tzArgs),
        this.pool.query(
          `SELECT extract(hour from e.ts AT TIME ZONE ${tzP})::int AS h,
                  extract(dow  from e.ts AT TIME ZONE ${tzP})::int AS d, count(*)::int AS n
           FROM evt e WHERE ${where} AND e.kind = 'evt.kill' GROUP BY 1, 2`, tzArgs),
        // Both rankings count each player's kills (per name the log gave them) first and name them
        // after: joining every kill in the window to its player before counting read the players
        // table once a kill — 360k times for a month of one busy server — to rank twenty-five.
        // The counts are read as `e`, so they are named by the same join and rule as the kills
        // were, and the lines are the same: grouped by the same id and name.
        this.pool.query(
          `WITH a AS (SELECT e.actor_player_id, e.actor_name, count(*) AS n
                        FROM evt e
                       WHERE ${where} AND e.kind = 'evt.kill' AND e.actor_player_id IS NOT NULL
                       GROUP BY 1, 2)
           SELECT e.actor_player_id AS id, ${EVT_ACTOR_NAME} AS name, sum(e.n)::int AS n
           FROM a e ${JOIN_EVT_ACTOR}
           GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 25`, args),
        // Team kills ranked, with that player's ordinary kills beside them: 4 team kills in a
        // 200-kill session is a bad night, 4 in 6 is someone to look at.
        this.pool.query(
          `WITH a AS (SELECT e.actor_player_id, e.actor_name,
                             count(*) FILTER (WHERE e.kind = 'evt.teamkill') AS tk,
                             count(*) FILTER (WHERE e.kind = 'evt.kill') AS kills
                        FROM evt e
                       WHERE ${where} AND e.actor_player_id IS NOT NULL
                       GROUP BY 1, 2)
           SELECT e.actor_player_id AS id, ${EVT_ACTOR_NAME} AS name,
                  sum(e.tk)::int AS tk, sum(e.kills)::int AS kills
           FROM a e ${JOIN_EVT_ACTOR}
           GROUP BY 1, 2 HAVING sum(e.tk) > 0
           ORDER BY tk DESC, 1 LIMIT 25`, args),
        // Attribute each event to the round it happened inside — driven from the ROUNDS that
        // overlap the window, one (server_id, ts) index range per round. The plain interval join
        // this replaced read as "drive from the small side", but the planner drove from the
        // events: every kill in the window index-scanned every round that started before it,
        // ~390M row checks for one week of an imported install, and the Combat tab never
        // answered. Rounds with no kills in the window drop out (the memory store's rule too).
        this.pool.query(
          `SELECT coalesce(m.map, 'Unknown') AS map, sum(c.kills)::int AS kills, sum(c.tk)::int AS tk
           FROM matches m
           CROSS JOIN LATERAL (
             SELECT count(*) FILTER (WHERE e.kind = 'evt.kill') AS kills,
                    count(*) FILTER (WHERE e.kind = 'evt.teamkill') AS tk
             FROM evt e
             WHERE e.server_id = m.server_id
               AND e.ts >= greatest(m.started_at, $1::timestamptz)
               AND e.ts < least(coalesce(m.ended_at, now()), $2::timestamptz)
               AND e.kind IN ('evt.kill','evt.teamkill')
           ) c
           WHERE m.started_at < $2 AND coalesce(m.ended_at, now()) > $1
             ${q.serverId ? "AND m.server_id = $3" : ""}
             AND c.kills + c.tk > 0
           GROUP BY 1 ORDER BY kills DESC`, args),
        this.pool.query(
          `SELECT count(*) FILTER (WHERE e.kind = 'evt.kill')::int AS kills,
                  count(*) FILTER (WHERE e.kind = 'evt.teamkill')::int AS tk,
                  count(DISTINCT e.actor_player_id)::int AS killers,
                  count(DISTINCT e.victim_player_id)::int AS victims
           FROM evt e WHERE ${where}`, args),
      ]);

      const weaponRows = new Map<string, { weapon: string; kills: number; teamkills: number }>();
      for (const r of weapons.rows) {
        const row = weaponRows.get(r.weapon) ?? { weapon: r.weapon, kills: 0, teamkills: 0 };
        if (r.kind === "evt.teamkill") row.teamkills += r.n; else row.kills += r.n;
        weaponRows.set(r.weapon, row);
      }
      const perDay = new Map<string, { date: string; kills: number; teamkills: number }>();
      for (const r of daily.rows) {
        const row = perDay.get(r.date) ?? { date: r.date, kills: 0, teamkills: 0 };
        if (r.kind === "evt.teamkill") row.teamkills += r.n; else row.kills += r.n;
        perDay.set(r.date, row);
      }
      const byHour = Array<number>(24).fill(0);
      const weekHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      for (const r of buckets.rows) {
        byHour[r.h] = (byHour[r.h] ?? 0) + r.n;
        const row = weekHour[r.d];
        if (row) row[r.h] = (row[r.h] ?? 0) + r.n;
      }
      const t = totals.rows[0] ?? {};
      return {
        totals: { kills: t.kills ?? 0, teamkills: t.tk ?? 0, killers: t.killers ?? 0, victims: t.victims ?? 0 },
        byWeapon: [...weaponRows.values()].sort((a, b) => (b.kills + b.teamkills) - (a.kills + a.teamkills)),
        daily: [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
        weekHour,
        byHour,
        topKillers: killers.rows.map((r: any) => ({ playerId: r.id, name: r.name, kills: r.n })),
        topTeamkillers: tkers.rows.map((r: any) => ({ playerId: r.id, name: r.name, teamkills: r.tk, kills: r.kills })),
        byMap: maps.rows.map((r: any) => ({ map: r.map, kills: r.kills, teamkills: r.tk })),
      };
    },
  };

  featurePresets = {
    list: async (feature: string): Promise<FeaturePresetRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM feature_presets WHERE feature = $1 ORDER BY lower(name)", [feature]);
      return rows.map(toFeaturePreset);
    },
    get: async (feature: string, name: string): Promise<FeaturePresetRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM feature_presets WHERE feature = $1 AND lower(name) = lower($2)", [feature, name]);
      return rows[0] ? toFeaturePreset(rows[0]) : null;
    },
    save: async (input: { feature: string; name: string; config: Record<string, unknown>; game?: string | null; createdByName: string }): Promise<FeaturePresetRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO feature_presets (id, feature, name, config, game, created_by_name, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6, now())
         ON CONFLICT (feature, lower(name)) DO UPDATE SET
           name=EXCLUDED.name, config=EXCLUDED.config, game=EXCLUDED.game, created_by_name=EXCLUDED.created_by_name, updated_at=now()
         RETURNING *`,
        [randomUUID(), input.feature, input.name, JSON.stringify(input.config), input.game ?? null, input.createdByName],
      );
      return toFeaturePreset(rows[0]);
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM feature_presets WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  rosterSnapshots = {
    record: async (input: RosterSnapshotInput): Promise<void> => {
      await this.pool.query(
        // `game` is taken from the server as the sample is written — the same rule matches use,
        // and for the same reason: a role number is only meaningful against the game it was
        // counted on.
        `INSERT INTO roster_snapshots (server_id, game, ts, player_count, composition, map_name, game_mode, allied_score, axis_score, queue_count, vip_queue_count)
         VALUES ($1, (SELECT game FROM servers WHERE id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (server_id, ts) DO NOTHING`,
        [input.serverId, input.ts, input.playerCount, JSON.stringify(packComposition(input.composition)),
          input.mapName ?? null, input.gameMode ?? null,
          input.alliedScore ?? null, input.axisScore ?? null,
          wholeOrNull(input.queueCount), wholeOrNull(input.vipQueueCount)]);
    },
    list: async (q: AnalyticsWindow): Promise<RosterSnapshotRow[]> => {
      const args: unknown[] = [q.from, q.to];
      let where = "ts >= $1 AND ts < $2";
      if (q.serverId) { args.push(q.serverId); where += ` AND server_id = $${args.length}`; }
      const { rows } = await this.pool.query(
        `SELECT id, server_id, game, ts, player_count, composition, map_name, game_mode, allied_score, axis_score, queue_count, vip_queue_count
         FROM roster_snapshots WHERE ${where} ORDER BY ts, server_id`, args);
      return rows.map((r: any) => ({
        id: String(r.id), serverId: r.server_id, game: r.game ?? null, ts: new Date(r.ts).toISOString(),
        playerCount: r.player_count, composition: unpackComposition(r.composition),
        mapName: r.map_name ?? null, gameMode: r.game_mode ?? null,
        alliedScore: r.allied_score ?? null, axisScore: r.axis_score ?? null,
        queueCount: r.queue_count ?? null, vipQueueCount: r.vip_queue_count ?? null,
      }));
    },
    scoreTimeline: async (serverId: string, fromIso: string, toIso: string): Promise<{ ts: string; alliedScore: number; axisScore: number }[]> => {
      // Three columns and the null-score rows dropped in SQL. No LIMIT, deliberately: the caller
      // is a parity surface that owes the whole timeline — see the interface note.
      const { rows } = await this.pool.query(
        `SELECT ts, allied_score, axis_score FROM roster_snapshots
          WHERE server_id = $1 AND ts >= $2 AND ts < $3
            AND allied_score IS NOT NULL AND axis_score IS NOT NULL
          ORDER BY ts`,
        [serverId, fromIso, toIso],
      );
      return rows.map((r: any) => ({
        ts: new Date(r.ts).toISOString(),
        alliedScore: Number(r.allied_score),
        axisScore: Number(r.axis_score),
      }));
    },
    latest: async (serverId: string): Promise<RosterSnapshotRow | null> => {
      const { rows } = await this.pool.query(
        `SELECT id, server_id, game, ts, player_count, composition, map_name, game_mode, allied_score, axis_score, queue_count, vip_queue_count
         FROM roster_snapshots WHERE server_id = $1 ORDER BY ts DESC LIMIT 1`, [serverId]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: String(r.id), serverId: r.server_id, game: r.game ?? null, ts: new Date(r.ts).toISOString(),
        playerCount: r.player_count, composition: unpackComposition(r.composition),
        mapName: r.map_name ?? null, gameMode: r.game_mode ?? null,
        alliedScore: r.allied_score ?? null, axisScore: r.axis_score ?? null,
        queueCount: r.queue_count ?? null, vipQueueCount: r.vip_queue_count ?? null,
      };
    },
  };

  layouts = {
    get: async (surface: string, scopeType: LayoutScope, scopeId: string): Promise<LayoutRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM layouts WHERE surface = $1 AND scope_type = $2 AND scope_id = $3", [surface, scopeType, scopeId]);
      if (!rows[0]) return null;
      const r = rows[0];
      return { id: r.id, scopeType: r.scope_type, scopeId: r.scope_id, surface: r.surface, config: r.config, updatedAt: new Date(r.updated_at).toISOString() };
    },
    set: async (surface: string, scopeType: LayoutScope, scopeId: string, config: Record<string, unknown>): Promise<LayoutRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO layouts (id, scope_type, scope_id, surface, config, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (scope_type, scope_id, surface)
         DO UPDATE SET config = EXCLUDED.config, updated_at = now()
         RETURNING *`,
        [randomUUID(), scopeType, scopeId, surface, JSON.stringify(config)],
      );
      const r = rows[0];
      return { id: r.id, scopeType: r.scope_type, scopeId: r.scope_id, surface: r.surface, config: r.config, updatedAt: new Date(r.updated_at).toISOString() };
    },
    remove: async (surface: string, scopeType: LayoutScope, scopeId: string): Promise<boolean> => {
      const res = await this.pool.query("DELETE FROM layouts WHERE surface = $1 AND scope_type = $2 AND scope_id = $3", [surface, scopeType, scopeId]);
      return (res.rowCount ?? 0) > 0;
    },
    countForScope: async (scopeType: LayoutScope, scopeId: string): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM layouts WHERE scope_type = $1 AND scope_id = $2", [scopeType, scopeId]);
      return rows[0]?.n ?? 0;
    },
  };

  ruleSections = {
    list: async (): Promise<RuleSectionRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM rule_sections ORDER BY created_at, id");
      return rows.map(toRuleSection);
    },
    create: async (name: string): Promise<RuleSectionRow> => {
      try {
        const { rows } = await this.pool.query("INSERT INTO rule_sections (id, name) VALUES ($1, $2) RETURNING *", [randomUUID(), name.trim()]);
        return toRuleSection(rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new RuleSectionNameTaken(name.trim());
        throw err;
      }
    },
    rename: async (id: string, name: string): Promise<RuleSectionRow | null> => {
      try {
        const { rows } = await this.pool.query("UPDATE rule_sections SET name = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, name.trim()]);
        return rows[0] ? toRuleSection(rows[0]) : null;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new RuleSectionNameTaken(name.trim());
        throw err;
      }
    },
    setEnabled: async (id: string, enabled: boolean): Promise<RuleSectionRow | null> => {
      const { rows } = await this.pool.query("UPDATE rule_sections SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, enabled]);
      return rows[0] ? toRuleSection(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM rule_sections WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  configVersions = {
    record: async (input: NewConfigVersion): Promise<ConfigVersionRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO config_versions (id, kind, target_id, target_name, change, before, after, actor_user_id, actor_name)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
        [randomUUID(), input.kind, input.targetId, input.targetName, input.change,
          input.before == null ? null : JSON.stringify(input.before), input.after == null ? null : JSON.stringify(input.after),
          input.actorUserId, input.actorName],
      );
      await this.pool.query(
        `DELETE FROM config_versions WHERE kind = $1 AND target_id = $2 AND seq < (
           SELECT min(seq) FROM (SELECT seq FROM config_versions WHERE kind = $1 AND target_id = $2 ORDER BY seq DESC LIMIT $3) kept)`,
        [input.kind, input.targetId, CONFIG_VERSIONS_KEPT],
      );
      return toConfigVersion(rows[0]);
    },
    list: async (kind: ConfigVersionKind, targetId: string, limit = CONFIG_VERSIONS_KEPT): Promise<ConfigVersionRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM config_versions WHERE kind = $1 AND target_id = $2 ORDER BY seq DESC LIMIT $3",
        [kind, targetId, limit],
      );
      return rows.map(toConfigVersion);
    },
    get: async (id: string): Promise<ConfigVersionRow | null> => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { rows } = await this.pool.query("SELECT * FROM config_versions WHERE id = $1", [id]);
      return rows[0] ? toConfigVersion(rows[0]) : null;
    },
    deletions: async (kind: ConfigVersionKind, limit = 50): Promise<ConfigVersionRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (target_id) * FROM config_versions WHERE kind = $1 AND change = 'delete' ORDER BY target_id, seq DESC
         ) latest ORDER BY seq DESC LIMIT $2`,
        [kind, limit],
      );
      return rows.map(toConfigVersion);
    },
  };

  enforcerRules = {
    list: async (): Promise<RuleRow[]> => {
      const { rows } = await this.pool.query(`${RULE_SELECT("enforcer_rules")} ORDER BY r.created_at`);
      return rows.map(toRule);
    },
    get: async (id: string): Promise<RuleRow | null> => {
      const { rows } = await this.pool.query(`${RULE_SELECT("enforcer_rules")} WHERE r.id = $1`, [id]);
      return rows[0] ? toRule(rows[0]) : null;
    },
    create: async (input: NewRule): Promise<RuleRow> => {
      const { rows } = await this.pool.query(
        `WITH written AS (
           INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours, delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes, alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params, active_hours, players_min, players_max, breaker_limit, match_minutes_min, match_minutes_max, count_per_match, require_tags, cap_count, cap_period, action_tag, points, section_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb,$25::jsonb,$26,$27,$28,$29,$30,$31,$32::jsonb,$33,$34,$35,$36,
                   (SELECT id FROM rule_sections WHERE id = $37::uuid)) RETURNING *)
         ${RULE_SELECT("written")}`,
        [input.id ?? randomUUID(), input.name, input.enabled ?? true, input.serverId ?? null, input.eventKind, input.match ?? null, input.threshold ?? 1, input.windowSec ?? 0, input.action, input.reason ?? null, input.hours ?? null, input.delaySec ?? 0, input.vipMinutes ?? 10, input.vipCooldownMinutes ?? 60, JSON.stringify(input.requireRoleIds ?? []), JSON.stringify(input.escalateActions ?? []), input.escalateResetMinutes ?? 120, input.alertEnabled ?? true, input.alertChannelId ?? null, JSON.stringify(input.immuneTags ?? []), JSON.stringify(input.immuneRoleIds ?? []), input.dryRun ?? false, input.immuneLevel ?? 0, input.params == null ? null : JSON.stringify(input.params), input.activeHours == null ? null : JSON.stringify(input.activeHours), input.playersMin ?? 0, input.playersMax ?? 0, input.breakerLimit ?? 10, input.matchMinutesMin ?? 0, input.matchMinutesMax ?? 0, input.countPerMatch ?? false, JSON.stringify(input.requireTags ?? []), input.capCount ?? 0, input.capPeriod ?? "day", input.actionTag ?? null, input.points ?? 0, input.sectionId ?? null],
      );
      return toRule(rows[0]);
    },
    update: async (id: string, patch: RulePatch): Promise<RuleRow | null> => {
      const cols: Record<string, string> = { name: "name", enabled: "enabled", serverId: "server_id", eventKind: "event_kind", match: "match", threshold: "threshold", windowSec: "window_sec", action: "action", reason: "reason", hours: "hours", delaySec: "delay_sec", vipMinutes: "vip_minutes", vipCooldownMinutes: "vip_cooldown_minutes", escalateResetMinutes: "escalate_reset_minutes", alertEnabled: "alert_enabled", alertChannelId: "alert_channel_id", dryRun: "dry_run", immuneLevel: "immune_level", playersMin: "players_min", playersMax: "players_max", breakerLimit: "breaker_limit", matchMinutesMin: "match_minutes_min", matchMinutesMax: "match_minutes_max", countPerMatch: "count_per_match", capCount: "cap_count", capPeriod: "cap_period", actionTag: "action_tag", points: "points", sectionId: "section_id" };
      const sets: string[] = [];
      const args: unknown[] = [id];
      for (const [k, col] of Object.entries(cols)) {
        if ((patch as Record<string, unknown>)[k] !== undefined) { args.push((patch as Record<string, unknown>)[k]); sets.push(`${col} = $${args.length}`); }
      }
      if (patch.requireRoleIds !== undefined) { args.push(JSON.stringify(patch.requireRoleIds)); sets.push(`require_role_ids = $${args.length}::jsonb`); }
      if (patch.escalateActions !== undefined) { args.push(JSON.stringify(patch.escalateActions)); sets.push(`escalate_actions = $${args.length}::jsonb`); }
      if (patch.immuneTags !== undefined) { args.push(JSON.stringify(patch.immuneTags)); sets.push(`immune_tags = $${args.length}::jsonb`); }
      if (patch.immuneRoleIds !== undefined) { args.push(JSON.stringify(patch.immuneRoleIds)); sets.push(`immune_role_ids = $${args.length}::jsonb`); }
      if (patch.requireTags !== undefined) { args.push(JSON.stringify(patch.requireTags)); sets.push(`require_tags = $${args.length}::jsonb`); }
      if (patch.params !== undefined) { args.push(patch.params == null ? null : JSON.stringify(patch.params)); sets.push(`params = $${args.length}::jsonb`); }
      if (patch.activeHours !== undefined) { args.push(patch.activeHours == null ? null : JSON.stringify(patch.activeHours)); sets.push(`active_hours = $${args.length}::jsonb`); }
      if (!sets.length) return this.enforcerRules.get(id);
      const { rows } = await this.pool.query(`WITH written AS (UPDATE enforcer_rules SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *) ${RULE_SELECT("written")}`, args);
      return rows[0] ? toRule(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM enforcer_rules WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
    setSection: async (ruleIds: string[], sectionId: string | null): Promise<number> => {
      const ids = [...new Set(ruleIds)].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      if (!ids.length) return 0;
      const { rowCount } = await this.pool.query("UPDATE enforcer_rules SET section_id = $2 WHERE id = ANY($1::uuid[])", [ids, sectionId]);
      return rowCount ?? 0;
    },
    setPause: async (id: string, pause: { until: string; reason: string; by: string } | null): Promise<RuleRow | null> => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { rows } = await this.pool.query(
        `WITH written AS (UPDATE enforcer_rules SET paused_until = $2, pause_reason = $3, paused_by = $4 WHERE id = $1 RETURNING *) ${RULE_SELECT("written")}`,
        [id, pause?.until ?? null, pause?.reason ?? null, pause?.by ?? null],
      );
      return rows[0] ? toRule(rows[0]) : null;
    },
    activity: async (since: string): Promise<Map<string, { lastFiredAt: string; count: number }>> => {
      // One grouped read for the whole page rather than a query per rule. Every enforcer audit
      // row carries its rule id in `data`, dry-runs and failures included: "it tried and could
      // not" is exactly as much proof of life as "it acted".
      const { rows } = await this.pool.query(
        `SELECT data->>'ruleId' AS rule_id, max(ts) AS last_fired, count(*)::int AS n
           FROM audit
          WHERE action LIKE 'enforcer.%' AND ts >= $1 AND data ? 'ruleId'
          GROUP BY data->>'ruleId'`,
        [since],
      );
      return new Map(rows.map((r: { rule_id: string; last_fired: string; n: number }) =>
        [r.rule_id, { lastFiredAt: new Date(r.last_fired).toISOString(), count: Number(r.n) }]));
    },
    recordCheck: async (ruleId: string, serverId: string, summary: RuleCheckSummary): Promise<void> => {
      await this.pool.query(
        `INSERT INTO rule_status (rule_id, server_id, checked_at, check_summary) VALUES ($1, $2, now(), $3::jsonb)
         ON CONFLICT (rule_id, server_id) DO UPDATE SET checked_at = now(), check_summary = EXCLUDED.check_summary`,
        [ruleId, serverId, JSON.stringify(summary)],
      );
    },
    recordSkip: async (ruleId: string, serverId: string, reason: string, playerName: string | null): Promise<void> => {
      await this.pool.query(
        `INSERT INTO rule_status (rule_id, server_id, skipped_at, skip_reason, skip_player) VALUES ($1, $2, now(), $3, $4)
         ON CONFLICT (rule_id, server_id) DO UPDATE SET skipped_at = now(), skip_reason = EXCLUDED.skip_reason, skip_player = EXCLUDED.skip_player`,
        [ruleId, serverId, reason.slice(0, 500), playerName],
      );
    },
    statuses: async (): Promise<RuleStatusRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM rule_status");
      return (rows as any[]).map((r) => ({
        ruleId: r.rule_id, serverId: r.server_id,
        checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
        check: r.check_summary ?? null,
        skippedAt: r.skipped_at ? new Date(r.skipped_at).toISOString() : null,
        skipReason: r.skip_reason ?? null, skipPlayer: r.skip_player ?? null,
      }));
    },
    firingCount: async (ruleId: string, subjectId: string, since: string | null, dryRun: boolean): Promise<number> => {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM rule_firings
          WHERE rule_id = $1 AND player_id = $2 AND dry_run = $3 AND ($4::timestamptz IS NULL OR fired_at >= $4::timestamptz)`,
        [ruleId, subjectId, dryRun, since],
      );
      return Number(rows[0]?.n ?? 0);
    },
    recordFiring: async (ruleId: string, subjectId: string, dryRun: boolean): Promise<void> => {
      await this.pool.query("INSERT INTO rule_firings (rule_id, player_id, dry_run) VALUES ($1, $2, $3)", [ruleId, subjectId, dryRun]);
    },
    claimOccurrence: async (ruleId: string, occurrence: string): Promise<boolean> => {
      // The rule may be gone between the read that found it due and this claim: nothing to claim.
      const { rows } = await this.pool.query(
        `INSERT INTO rule_occurrences (rule_id, occurrence)
         SELECT id, $2 FROM enforcer_rules WHERE id = $1::uuid
         ON CONFLICT (rule_id, occurrence) DO NOTHING
         RETURNING rule_id`,
        [ruleId, occurrence],
      );
      return rows.length > 0;
    },
    lastVipGrantAt: async (ruleId: string, serverId: string, playerId: string): Promise<string | null> => {
      const { rows } = await this.pool.query(
        "SELECT granted_at FROM enforcer_vip_grants WHERE rule_id = $1 AND server_id = $2 AND player_id = $3",
        [ruleId, serverId, playerId],
      );
      return rows[0] ? new Date(rows[0].granted_at).toISOString() : null;
    },
    recordVipGrant: async (ruleId: string, serverId: string, playerId: string): Promise<void> => {
      await this.pool.query(
        `INSERT INTO enforcer_vip_grants (rule_id, server_id, player_id, granted_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (rule_id, server_id, player_id) DO UPDATE SET granted_at = now()`,
        [ruleId, serverId, playerId],
      );
    },
  };

  vips = {
    list: async (serverId?: string): Promise<VipRow[]> => {
      const { rows } = serverId
        ? await this.pool.query(`SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} WHERE v.server_id = $1 ORDER BY v.created_at`, [serverId])
        : await this.pool.query(`SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} ORDER BY v.created_at`);
      return rows.map(toVip);
    },
    listByPlayer: async (playerId: string): Promise<VipRow[]> => {
      const { rows } = await this.pool.query(`SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} WHERE v.player_id = $1 ORDER BY v.created_at`, [playerId]);
      return rows.map(toVip);
    },
    get: async (serverId: string, playerId: string): Promise<VipRow | null> => {
      const { rows } = await this.pool.query(`SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} WHERE v.server_id = $1 AND v.player_id = $2`, [serverId, playerId]);
      return rows[0] ? toVip(rows[0]) : null;
    },
    upsert: async (input: NewVip): Promise<VipRow & { endedHold?: VipGroupHold | null }> => {
      // On conflict, keep the original creator/created_at; refresh name/comment/expiration —
      // EXCEPT that a permanent grant (expiration NULL) keeps its NULL unless the caller passed
      // replacePermanent. See NewVip.replacePermanent: this floor lives in the store so no
      // future caller can reintroduce the paid-VIP downgrade by taking a new path to this row.
      // A grant a group perk holds stays permanent whatever this write says (its time belongs in
      // the frozen balance — bankGroupHold), unless the write is a person granting permanent VIP
      // outright (endsGroupHold), which drops the hold and makes the grant theirs. A dated write
      // that lands on a held grant anyway (read just before the hold began) is banked: the larger
      // of the balance and its time, so the grant counts and a cut never reaches frozen time.
      // The banked time is measured on the grant's own clock: a banked VIP timeout stopped it at
      // paused_at ($11 = NewVip.thawsPause: the timeout's end, already measured from now). `old`
      // reads the row as the statement's snapshot has it — before this write — so a hold the write
      // ended is reported back. (No FOR UPDATE: a locking read evaluated in RETURNING follows the
      // row to the version this very statement wrote.) A write either floor turns away keeps the
      // grant's note too: a staff "paid" marker is not replaced by a grant that never landed — but
      // a note a person typed for it lands ($12 = NewVip.typedNote; never on a held grant).
      // And a DATED grant keeps the later of its date and the written one unless the write may
      // shorten it ($13 = NewVip.mayShorten, or replacePermanent's exact set): automation only
      // ever adds time. A date in CRCON's year-3000 "never expires" range is stored as permanent.
      const expiration = storedVipExpiration(input.expiration);
      const { rows } = await this.pool.query(
        `WITH old AS (SELECT group_hold FROM vips WHERE server_id = $2 AND player_id = $3)
         INSERT INTO vips (id, server_id, player_id, player_name, comment, expiration, created_by_user_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (server_id, player_id) DO UPDATE
           SET player_name = COALESCE(EXCLUDED.player_name, vips.player_name),
               comment = CASE
                 WHEN vips.group_hold IS NOT NULL AND NOT $10::boolean THEN vips.comment
                 WHEN vips.expiration IS NULL AND EXCLUDED.expiration IS NOT NULL AND NOT $9::boolean AND vips.group_hold IS NULL AND NOT $12::boolean THEN vips.comment
                 WHEN EXCLUDED.expiration < vips.expiration AND NOT $13::boolean AND vips.group_hold IS NULL AND NOT $12::boolean THEN vips.comment
                 ELSE COALESCE(EXCLUDED.comment, vips.comment)
               END,
               expiration = CASE
                 WHEN vips.group_hold IS NOT NULL AND NOT $10::boolean THEN vips.expiration
                 WHEN vips.expiration IS NULL AND EXCLUDED.expiration IS NOT NULL AND NOT $9::boolean AND vips.group_hold IS NULL THEN vips.expiration
                 WHEN EXCLUDED.expiration < vips.expiration AND NOT $13::boolean AND vips.group_hold IS NULL THEN vips.expiration
                 ELSE EXCLUDED.expiration
               END,
               group_hold = CASE
                 WHEN $10::boolean THEN NULL
                 WHEN vips.group_hold IS NOT NULL AND EXCLUDED.expiration IS NOT NULL THEN jsonb_set(vips.group_hold, '{bankedMs}', to_jsonb(GREATEST(
                   COALESCE((vips.group_hold->>'bankedMs')::bigint, 0),
                   FLOOR(EXTRACT(EPOCH FROM (EXCLUDED.expiration - CASE
                     WHEN vips.pause_mode = 'banked' AND vips.paused_until IS NOT NULL AND vips.paused_at IS NOT NULL AND NOT $11::boolean THEN vips.paused_at
                     ELSE now() END)) * 1000)::bigint)))
                 ELSE vips.group_hold
               END,
               updated_at = now()
         RETURNING *, CASE WHEN $10::boolean THEN (SELECT group_hold FROM old) END AS ended_hold`,
        [randomUUID(), input.serverId, input.playerId, input.playerName ?? null, input.comment ?? null, expiration, input.createdByUserId ?? null, input.createdByName, input.replacePermanent === true, input.endsGroupHold === true, input.thawsPause === true, input.typedNote === true, input.mayShorten === true || input.replacePermanent === true],
      );
      return { ...toVip(rows[0]), endedHold: toVipGroupHold(rows[0].ended_hold) };
    },
    importOne: async (input: NewVip): Promise<{ row: VipRow; inserted: boolean }> => {
      // DO NOTHING on conflict — the live grant wins outright. `xmax = 0` is Postgres's own tell for
      // "this RETURNING row came from the INSERT, not an UPDATE", which distinguishes a fresh insert
      // from a conflict without a second round trip. DO NOTHING returns no row at all on conflict,
      // so the existing grant is fetched separately to report it back unchanged.
      const { rows } = await this.pool.query(
        `INSERT INTO vips (id, server_id, player_id, player_name, comment, expiration, created_by_user_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (server_id, player_id) DO NOTHING
         RETURNING *, (xmax = 0) AS inserted`,
        [randomUUID(), input.serverId, input.playerId, input.playerName ?? null, input.comment ?? null, storedVipExpiration(input.expiration), input.createdByUserId ?? null, input.createdByName],
      );
      if (rows[0]) return { row: toVip(rows[0]), inserted: true };
      const { rows: kept } = await this.pool.query(
        `SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} WHERE v.server_id = $1 AND v.player_id = $2`,
        [input.serverId, input.playerId],
      );
      return { row: toVip(kept[0]), inserted: false };
    },
    remove: async (serverId: string, playerId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM vips WHERE server_id = $1 AND player_id = $2", [serverId, playerId]);
      return (rowCount ?? 0) > 0;
    },
    removeExpired: async (serverId: string, playerId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        "DELETE FROM vips WHERE server_id = $1 AND player_id = $2 AND group_hold IS NULL AND expiration IS NOT NULL AND expiration <= now()",
        [serverId, playerId],
      );
      return (rowCount ?? 0) > 0;
    },
    updateTimedExpiration: async (serverId: string, playerId: string, expiration: string): Promise<VipRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE vips SET expiration = $3, updated_at = now()
         WHERE server_id = $1 AND player_id = $2 AND group_hold IS NULL AND expiration IS NOT NULL RETURNING *`,
        [serverId, playerId, expiration],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    removeTimed: async (serverId: string, playerId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        "DELETE FROM vips WHERE server_id = $1 AND player_id = $2 AND group_hold IS NULL AND expiration IS NOT NULL",
        [serverId, playerId],
      );
      return (rowCount ?? 0) > 0;
    },
    expired: async (nowIso: string): Promise<VipRow[]> => {
      // A banked pause FREEZES the meter: those rows must not expire mid-pause (the resume adds
      // the frozen time back). Running-mode pauses expire normally — that loss is the point.
      const { rows } = await this.pool.query(
        "SELECT * FROM vips WHERE expiration IS NOT NULL AND expiration <= $1 AND NOT (pause_mode = 'banked' AND paused_until IS NOT NULL)",
        [nowIso],
      );
      return rows.map(toVip);
    },
    setPause: async (serverId: string, playerId: string, pause: VipPause | null): Promise<VipRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE vips SET paused_until = $3, pause_reason = $4, paused_by = $5,
                         pause_mode = $6, paused_at = $7, updated_at = now()
         WHERE server_id = $1 AND player_id = $2 RETURNING *`,
        [serverId, playerId, pause?.until ?? null, pause?.reason ?? null, pause?.by ?? null,
         pause ? (pause.mode ?? "running") : null, pause ? (pause.at ?? new Date().toISOString()) : null],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    pauseLapsed: async (nowIso: string): Promise<VipRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM vips WHERE paused_until IS NOT NULL AND paused_until <= $1", [nowIso]);
      return rows.map(toVip);
    },
    startGroupHold: async (input: { serverId: string; playerId: string; playerName?: string | null; groups: VipGroupHoldSource[]; createdByName: string; whilePerks?: boolean }): Promise<VipRow | null> => {
      // The balance is measured here, in the same statement that makes the grant permanent, so a
      // grant landing between a read and this write cannot be lost. A banked pause froze its own
      // meter at paused_at; a running one (and an unpaused grant) is measured from now. A grant
      // that is ALREADY permanent and held by nobody is left alone (the WHERE refuses the update,
      // RETURNING is empty) — that permanent is not the group's.
      const groups = JSON.stringify(input.groups);
      const comment = `group: ${input.groups.map((g) => g.name).filter(Boolean).join(", ") || "perk"}`;
      // whilePerks ($8): only while every group named still carries a perk with the severance being
      // recorded. The groups are read under SHARE locks, so switching a perk off either lands first
      // (and nothing is written here) or waits for this hold — which its own severance write then
      // reaches.
      const { rows } = await this.pool.query(
        `WITH perks AS (
           SELECT id::text AS id, COALESCE((vip_perk->>'severanceMinutes')::int, 0) AS sev, vip_perk IS NOT NULL AS has
           FROM player_groups WHERE $8::boolean AND id::text IN (SELECT n->>'id' FROM jsonb_array_elements($7::jsonb) n)
           FOR SHARE
         )
         INSERT INTO vips (id, server_id, player_id, player_name, comment, expiration, created_by_user_id, created_by_name, group_hold)
         SELECT $1,$2,$3,$4,$5,NULL,NULL,$6, jsonb_build_object('since', to_jsonb(now()), 'bankedMs', 0, 'groups', $7::jsonb)
         WHERE NOT $8::boolean OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($7::jsonb) n
           WHERE NOT EXISTS (SELECT 1 FROM perks p WHERE p.id = n->>'id' AND p.has AND p.sev = COALESCE((n->>'severanceMinutes')::int, 0)))
         ON CONFLICT (server_id, player_id) DO UPDATE
           SET player_name = COALESCE(EXCLUDED.player_name, vips.player_name),
               group_hold = CASE
                 WHEN vips.group_hold IS NOT NULL THEN jsonb_set(vips.group_hold, '{groups}', $7::jsonb)
                 ELSE jsonb_build_object(
                   'since', to_jsonb(now()),
                   'bankedMs', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (vips.expiration - CASE
                       WHEN vips.pause_mode = 'banked' AND vips.paused_until IS NOT NULL AND vips.paused_at IS NOT NULL THEN vips.paused_at
                       ELSE now() END)) * 1000))::bigint,
                   'groups', $7::jsonb)
               END,
               expiration = NULL,
               updated_at = now()
           WHERE vips.expiration IS NOT NULL OR vips.group_hold IS NOT NULL
         RETURNING *`,
        [randomUUID(), input.serverId, input.playerId, input.playerName ?? null, comment, input.createdByName, groups, input.whilePerks === true],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    setGroupHoldSources: async (serverId: string, playerId: string, groups: VipGroupHoldSource[], expect?: VipGroupHoldSource[]): Promise<VipRow | null> => {
      // With `expect`: only while the hold remembers the same groups with the same severances —
      // compared as (id, severance) pairs, ignoring order and names — and every group named still
      // carries a perk with the severance being written.
      const { rows } = await this.pool.query(
        `UPDATE vips SET group_hold = jsonb_set(group_hold, '{groups}', $3::jsonb), updated_at = now()
         WHERE server_id = $1 AND player_id = $2 AND group_hold IS NOT NULL
           AND ($4::jsonb IS NULL OR (
             (SELECT COALESCE(jsonb_agg(jsonb_build_array(g->>'id', COALESCE((g->>'severanceMinutes')::int, 0)) ORDER BY g->>'id'), '[]'::jsonb)
                FROM jsonb_array_elements(group_hold->'groups') g)
             = (SELECT COALESCE(jsonb_agg(jsonb_build_array(g->>'id', COALESCE((g->>'severanceMinutes')::int, 0)) ORDER BY g->>'id'), '[]'::jsonb)
                FROM jsonb_array_elements($4::jsonb) g)
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements($3::jsonb) n
               WHERE NOT EXISTS (
                 SELECT 1 FROM player_groups pg
                 WHERE pg.id::text = n->>'id' AND pg.vip_perk IS NOT NULL
                   AND COALESCE((pg.vip_perk->>'severanceMinutes')::int, 0) = COALESCE((n->>'severanceMinutes')::int, 0)))))
         RETURNING *`,
        [serverId, playerId, JSON.stringify(groups), expect ? JSON.stringify(expect) : null],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    bankGroupHold: async (serverId: string, playerId: string, change: { addMs?: number; atLeastMs?: number }): Promise<VipRow | null> => {
      const add = Math.max(0, Math.round(change.addMs ?? 0));
      const atLeast = Math.max(0, Math.round(change.atLeastMs ?? 0));
      const { rows } = await this.pool.query(
        `UPDATE vips SET group_hold = jsonb_set(group_hold, '{bankedMs}',
             to_jsonb(GREATEST(COALESCE((group_hold->>'bankedMs')::bigint, 0) + $3::bigint, $4::bigint))),
           updated_at = now()
         WHERE server_id = $1 AND player_id = $2 AND group_hold IS NOT NULL RETURNING *`,
        [serverId, playerId, add, atLeast],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    cutGroupHold: async (serverId: string, playerId: string, change: { cutMs?: number; all?: boolean }): Promise<{ row: VipRow; removedMs: number } | null> => {
      // The balance before is read under the row lock the update takes, so `removedMs` is what this
      // write took — not an earlier read that a grant banked meanwhile would make wrong.
      const { rows } = await this.pool.query(
        `WITH before AS (
           SELECT COALESCE((group_hold->>'bankedMs')::bigint, 0) AS banked FROM vips
            WHERE server_id = $1 AND player_id = $2 AND group_hold IS NOT NULL FOR UPDATE
         )
         UPDATE vips SET group_hold = jsonb_set(group_hold, '{bankedMs}',
             to_jsonb(CASE WHEN $3::boolean THEN 0 ELSE GREATEST(before.banked - $4::bigint, 0) END)),
           updated_at = now()
         FROM before
         WHERE server_id = $1 AND player_id = $2 AND group_hold IS NOT NULL
         RETURNING vips.*, before.banked AS banked_before`,
        [serverId, playerId, change.all === true, Math.max(0, Math.round(change.cutMs ?? 0))],
      );
      if (!rows[0]) return null;
      const row = toVip(rows[0]);
      return { row, removedMs: Number(rows[0].banked_before) - (row.groupHold?.bankedMs ?? 0) };
    },
    endGroupHold: async (serverId: string, playerId: string, expiration: string, expect?: { bankedMs: number; severanceMinutes: number }): Promise<VipRow | null> => {
      // A banked pause running across the release counts only its time AFTER it (while held the
      // grant was permanent and froze nothing), so its anchor moves to now. With `expect`, the row
      // must still carry the balance and largest severance the caller planned with.
      const { rows } = await this.pool.query(
        `UPDATE vips SET expiration = $3, group_hold = NULL,
           paused_at = CASE WHEN pause_mode = 'banked' AND paused_until IS NOT NULL THEN now() ELSE paused_at END,
           updated_at = now()
         WHERE server_id = $1 AND player_id = $2 AND group_hold IS NOT NULL
           AND ($4::bigint IS NULL OR COALESCE((group_hold->>'bankedMs')::bigint, 0) = $4::bigint)
           AND ($5::int IS NULL OR COALESCE((SELECT max(COALESCE((g->>'severanceMinutes')::int, 0)) FROM jsonb_array_elements(group_hold->'groups') g), 0) = $5::int)
         RETURNING *`,
        // A balance banked off a year-3000 row hands back a date in that range: permanent, stored so.
        [serverId, playerId, storedVipExpiration(expiration), expect ? Math.round(expect.bankedMs) : null, expect ? Math.round(expect.severanceMinutes) : null],
      );
      return rows[0] ? toVip(rows[0]) : null;
    },
    groupHeld: async (): Promise<VipRow[]> => {
      const { rows } = await this.pool.query(`SELECT v.*, ${CURRENT_NAME("v")} FROM vips v ${JOIN_PLAYER("v")} WHERE v.group_hold IS NOT NULL ORDER BY v.created_at`);
      return rows.map(toVip);
    },
    setGroupSeverance: async (groupId: string, minutes: number): Promise<number> => {
      const { rowCount } = await this.pool.query(
        `UPDATE vips SET group_hold = jsonb_set(group_hold, '{groups}', COALESCE((
             SELECT jsonb_agg(CASE WHEN g->>'id' = $1 THEN jsonb_set(g, '{severanceMinutes}', to_jsonb($2::int)) ELSE g END ORDER BY ord)
             FROM jsonb_array_elements(group_hold->'groups') WITH ORDINALITY AS x(g, ord)), '[]'::jsonb)),
           updated_at = now()
         WHERE group_hold IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(group_hold->'groups') g WHERE g->>'id' = $1)`,
        [groupId, Math.max(0, Math.round(minutes))],
      );
      return rowCount ?? 0;
    },
  };

  playerTriggers = {
    listArmed: async (): Promise<PlayerTriggerRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_triggers WHERE enabled AND disarmed_at IS NULL");
      return rows.map(toPlayerTrigger);
    },
    listAll: async (limit = 200, serverIds?: string[]): Promise<PlayerTriggerRow[]> => {
      // `server_id::text` rather than a uuid[] cast: the ids arrive from a caller's grant list,
      // and a malformed one should narrow the read, never throw 22P02 over the whole overview.
      const { rows } = await this.pool.query(
        `SELECT * FROM player_triggers
          WHERE $2::text[] IS NULL OR server_id IS NULL OR server_id::text = ANY($2::text[])
          ORDER BY (enabled AND disarmed_at IS NULL) DESC, created_at DESC LIMIT $1`,
        [limit, serverIds ?? null]);
      return rows.map(toPlayerTrigger);
    },
    listByPlayer: async (playerId: string): Promise<PlayerTriggerRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_triggers WHERE player_id = $1 ORDER BY created_at DESC", [playerId]);
      return rows.map(toPlayerTrigger);
    },
    get: async (id: string): Promise<PlayerTriggerRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM player_triggers WHERE id = $1", [id]);
      return rows[0] ? toPlayerTrigger(rows[0]) : null;
    },
    create: async (input: NewPlayerTrigger): Promise<PlayerTriggerRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO player_triggers (id, player_id, player_name, server_id, event, steps, fire_once, note, created_by_user_id, created_by_name, params)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(), input.playerId, input.playerName ?? null, input.serverId ?? null, input.event,
         JSON.stringify(input.steps), input.fireOnce ?? true, input.note ?? null,
         input.createdByUserId ?? null, input.createdByName, JSON.stringify(input.params ?? {})],
      );
      return toPlayerTrigger(rows[0]);
    },
    update: async (id: string, patch: { enabled?: boolean; note?: string | null }): Promise<PlayerTriggerRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_triggers SET
           enabled = COALESCE($2, enabled),
           note = CASE WHEN $3::boolean THEN $4 ELSE note END
         WHERE id = $1 RETURNING *`,
        [id, patch.enabled ?? null, patch.note !== undefined, patch.note ?? null],
      );
      return rows[0] ? toPlayerTrigger(rows[0]) : null;
    },
    edit: async (id: string, def: PlayerTriggerEdit): Promise<PlayerTriggerRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_triggers SET
           server_id = $2, event = $3, steps = $4, fire_once = $5, note = $6,
           updated_at = now(), updated_by_name = $7,
           disarmed_at = CASE WHEN $8::boolean THEN NULL ELSE disarmed_at END,
           params = $9
         WHERE id = $1 RETURNING *`,
        [id, def.serverId, def.event, JSON.stringify(def.steps), def.fireOnce, def.note, def.editedByName, def.rearm === true, JSON.stringify(def.params ?? {})],
      );
      return rows[0] ? toPlayerTrigger(rows[0]) : null;
    },
    recordFire: async (id: string, disarm: boolean, at: string): Promise<PlayerTriggerRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_triggers SET
           fired_count = fired_count + 1,
           last_fired_at = $2,
           disarmed_at = CASE WHEN $3::boolean THEN $2 ELSE disarmed_at END
         WHERE id = $1 RETURNING *`,
        [id, at, disarm],
      );
      return rows[0] ? toPlayerTrigger(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM player_triggers WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  consoleAdmins = {
    list: async (serverId?: string): Promise<ConsoleAdminRow[]> => {
      const { rows } = serverId
        ? await this.pool.query(`SELECT c.*, ${CURRENT_NAME("c")} FROM console_admins c ${JOIN_PLAYER("c")} WHERE c.server_id = $1 ORDER BY c.created_at`, [serverId])
        : await this.pool.query(`SELECT c.*, ${CURRENT_NAME("c")} FROM console_admins c ${JOIN_PLAYER("c")} ORDER BY c.created_at`);
      return rows.map(toConsoleAdmin);
    },
    get: async (serverId: string, playerId: string): Promise<ConsoleAdminRow | null> => {
      const { rows } = await this.pool.query(`SELECT c.*, ${CURRENT_NAME("c")} FROM console_admins c ${JOIN_PLAYER("c")} WHERE c.server_id = $1 AND c.player_id = $2`, [serverId, playerId]);
      return rows[0] ? toConsoleAdmin(rows[0]) : null;
    },
    upsert: async (input: NewConsoleAdmin): Promise<ConsoleAdminRow> => {
      // On conflict, keep the original creator/created_at; refresh name/group/comment/expiration.
      const { rows } = await this.pool.query(
        `INSERT INTO console_admins (id, server_id, player_id, player_name, admin_group, comment, expiration, created_by_user_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (server_id, player_id) DO UPDATE
           SET player_name = COALESCE(EXCLUDED.player_name, console_admins.player_name),
               admin_group = EXCLUDED.admin_group,
               comment = COALESCE(EXCLUDED.comment, console_admins.comment),
               expiration = EXCLUDED.expiration,
               updated_at = now()
         RETURNING *`,
        [randomUUID(), input.serverId, input.playerId, input.playerName ?? null, input.adminGroup, input.comment ?? null, input.expiration ?? null, input.createdByUserId ?? null, input.createdByName],
      );
      return toConsoleAdmin(rows[0]);
    },
    remove: async (serverId: string, playerId: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM console_admins WHERE server_id = $1 AND player_id = $2", [serverId, playerId]);
      return (rowCount ?? 0) > 0;
    },
    expired: async (nowIso: string): Promise<ConsoleAdminRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM console_admins WHERE expiration IS NOT NULL AND expiration <= $1", [nowIso]);
      return rows.map(toConsoleAdmin);
    },
  };

  playerGroups = {
    list: async (): Promise<PlayerGroupRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT g.*, (SELECT count(*) FROM player_group_members m WHERE m.group_id = g.id)::int AS member_count
         FROM player_groups g ORDER BY g.name`,
      );
      return rows.map(toPlayerGroup);
    },
    get: async (id: string): Promise<PlayerGroupRow | null> => {
      const { rows } = await this.pool.query(
        `SELECT g.*, (SELECT count(*) FROM player_group_members m WHERE m.group_id = g.id)::int AS member_count
         FROM player_groups g WHERE g.id = $1`, [id],
      );
      return rows[0] ? toPlayerGroup(rows[0]) : null;
    },
    create: async (input: { name: string; description?: string | null; createdByUserId?: string | null; createdByName: string }): Promise<PlayerGroupRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO player_groups (id, name, description, created_by_user_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5) RETURNING *, 0 AS member_count`,
        [randomUUID(), input.name, input.description ?? null, input.createdByUserId ?? null, input.createdByName],
      );
      return toPlayerGroup(rows[0]);
    },
    setDiscordRole: async (id: string, roleId: string | null): Promise<PlayerGroupRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_groups SET discord_role_id = $2, updated_at = now() WHERE id = $1
         RETURNING *, (SELECT count(*) FROM player_group_members m WHERE m.group_id = player_groups.id)::int AS member_count`,
        [id, roleId || null],
      );
      return rows[0] ? toPlayerGroup(rows[0]) : null;
    },
    setVipPerk: async (id: string, perk: GroupVipPerk | null): Promise<PlayerGroupRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_groups SET vip_perk = $2::jsonb, updated_at = now() WHERE id = $1
         RETURNING *, (SELECT count(*) FROM player_group_members m WHERE m.group_id = player_groups.id)::int AS member_count`,
        [id, perk ? JSON.stringify(perk) : null],
      );
      return rows[0] ? toPlayerGroup(rows[0]) : null;
    },
    update: async (id: string, patch: { name?: string; description?: string | null }): Promise<PlayerGroupRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE player_groups SET
           name = COALESCE($2, name),
           description = CASE WHEN $3 THEN $4 ELSE description END,
           updated_at = now()
         WHERE id = $1
         RETURNING *, (SELECT count(*) FROM player_group_members m WHERE m.group_id = player_groups.id)::int AS member_count`,
        [id, patch.name ?? null, patch.description !== undefined, patch.description ?? null],
      );
      return rows[0] ? toPlayerGroup(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM player_groups WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
    members: async (groupId: string): Promise<PlayerGroupMemberRow[]> => {
      const { rows } = await this.pool.query(`SELECT m.*, ${CURRENT_NAME("m")} FROM player_group_members m ${JOIN_PLAYER("m")} WHERE m.group_id = $1 ORDER BY m.added_at`, [groupId]);
      return rows.map(toPlayerGroupMember);
    },
    addMember: async (input: { groupId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<PlayerGroupMemberRow> => {
      // One statement, so the change and its queued event cannot part: a row that was INSERTED
      // (xmax = 0 — the upsert's update arm sets it) is a real join; a refreshed name is not. A
      // re-add keeps who listed them first (the source too).
      const { rows } = await this.pool.query(
        `WITH up AS (
           INSERT INTO player_group_members (group_id, player_id, player_name, added_by_name)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (group_id, player_id) DO UPDATE
             SET player_name = COALESCE(EXCLUDED.player_name, player_group_members.player_name)
           RETURNING *, (xmax = 0) AS inserted
         ), ev AS (
           INSERT INTO player_group_events (id, group_id, group_name, player_id, player_name, kind)
           SELECT $5::uuid, up.group_id, g.name, up.player_id, up.player_name, 'joined'
           FROM up JOIN player_groups g ON g.id = up.group_id
           WHERE up.inserted
         )
         SELECT * FROM up`,
        [input.groupId, input.playerId, input.playerName ?? null, input.addedByName, randomUUID()],
      );
      return toPlayerGroupMember(rows[0]);
    },
    removeMember: async (groupId: string, playerId: string): Promise<boolean> => {
      const { rows } = await this.pool.query(
        `WITH del AS (
           DELETE FROM player_group_members WHERE group_id = $1 AND player_id = $2 RETURNING *
         ), ev AS (
           INSERT INTO player_group_events (id, group_id, group_name, player_id, player_name, kind)
           SELECT $3::uuid, del.group_id, g.name, del.player_id, del.player_name, 'left'
           FROM del JOIN player_groups g ON g.id = del.group_id
         )
         SELECT count(*)::int AS n FROM del`,
        [groupId, playerId, randomUUID()],
      );
      return (rows[0]?.n ?? 0) > 0;
    },
    syncAddMember: async (input: { groupId: string; roleId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<boolean> => {
      // The group row is read under KEY SHARE: a delete of the group waits for this insert or wins
      // before it, so the add never meets a group that vanished between the check and the write.
      const { rows } = await this.pool.query(
        `WITH g AS (
           SELECT id, name FROM player_groups WHERE id = $1 AND discord_role_id = $2 FOR KEY SHARE
         ), up AS (
           INSERT INTO player_group_members (group_id, player_id, player_name, added_by_name, source)
           SELECT g.id, $3, $4, $5, 'discord' FROM g
           ON CONFLICT (group_id, player_id) DO NOTHING
           RETURNING *
         ), ev AS (
           INSERT INTO player_group_events (id, group_id, group_name, player_id, player_name, kind)
           SELECT $6::uuid, up.group_id, g.name, up.player_id, up.player_name, 'joined'
           FROM up JOIN g ON g.id = up.group_id
         )
         SELECT count(*)::int AS n FROM up`,
        [input.groupId, input.roleId, input.playerId, input.playerName ?? null, input.addedByName, randomUUID()],
      );
      return (rows[0]?.n ?? 0) > 0;
    },
    syncRemoveMember: async (input: { groupId: string; roleId: string; playerId: string }): Promise<boolean> => {
      const { rows } = await this.pool.query(
        `WITH del AS (
           DELETE FROM player_group_members m USING player_groups g
           WHERE m.group_id = $1 AND m.player_id = $2 AND m.source = 'discord'
             AND g.id = m.group_id AND g.discord_role_id = $3
           RETURNING m.group_id, m.player_id, m.player_name, g.name AS group_name
         ), ev AS (
           INSERT INTO player_group_events (id, group_id, group_name, player_id, player_name, kind)
           SELECT $4::uuid, del.group_id, del.group_name, del.player_id, del.player_name, 'left' FROM del
         )
         SELECT count(*)::int AS n FROM del`,
        [input.groupId, input.playerId, input.roleId, randomUUID()],
      );
      return (rows[0]?.n ?? 0) > 0;
    },
    takeEvents: async (limit: number): Promise<PlayerGroupEventRow[]> => {
      // A claim older than GROUP_EVENT_CLAIM_MS is a taker that died: dropped, never handed out twice.
      await this.pool.query(`DELETE FROM player_group_events WHERE claimed_at IS NOT NULL AND claimed_at < now() - ($1::bigint * interval '1 millisecond')`, [GROUP_EVENT_CLAIM_MS]);
      // Due, unclaimed ones only, and a member's OLDEST queued change only: a later one waits
      // behind it — claimed (being worked on elsewhere), due or not — so a removal never overtakes
      // the join it follows in any process. Claimed, not deleted: the row keeps blocking until it
      // is finished (ackEvents) or put back (deferEvent).
      const { rows } = await this.pool.query(
        `UPDATE player_group_events SET claimed_at = now()
         WHERE id IN (
           SELECT e.id FROM player_group_events e
           WHERE e.claimed_at IS NULL AND e.not_before <= now()
             AND NOT EXISTS (
               SELECT 1 FROM player_group_events o
               WHERE o.group_id = e.group_id AND o.player_id = e.player_id AND (o.created_at, o.id) < (e.created_at, e.id))
           ORDER BY e.created_at, e.id LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING *, EXISTS (
           SELECT 1 FROM player_group_events l
           WHERE l.group_id = player_group_events.group_id AND l.player_id = player_group_events.player_id
             AND (l.created_at, l.id) > (player_group_events.created_at, player_group_events.id)) AS superseded`,
        [Math.max(0, Math.floor(limit))],
      );
      return rows
        .map((r): PlayerGroupEventRow => ({
          id: r.id, groupId: r.group_id, groupName: r.group_name, playerId: r.player_id,
          playerName: r.player_name ?? null, kind: r.kind === "left" ? "left" : "joined",
          createdAt: new Date(r.created_at).toISOString(),
          notBefore: new Date(r.not_before ?? r.created_at).toISOString(),
          ruleIds: Array.isArray(r.rule_ids) ? r.rule_ids.map(String) : null,
          superseded: r.superseded === true,
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    ackEvents: async (ids: string[]): Promise<void> => {
      if (!ids.length) return;
      await this.pool.query("DELETE FROM player_group_events WHERE id = ANY($1::uuid[])", [ids]);
    },
    deferEvent: async (event: PlayerGroupEventRow, notBefore: string, ruleIds: string[] | null): Promise<void> => {
      // Still queued (claimed): unclaimed in place with its new time and rules. Gone (a claim that
      // outlived GROUP_EVENT_CLAIM_MS): back with its own created_at, so it keeps its place.
      await this.pool.query(
        `INSERT INTO player_group_events (id, group_id, group_name, player_id, player_name, kind, created_at, not_before, rule_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::text[])
         ON CONFLICT (id) DO UPDATE SET not_before = EXCLUDED.not_before, rule_ids = EXCLUDED.rule_ids, claimed_at = NULL`,
        [event.id, event.groupId, event.groupName, event.playerId, event.playerName, event.kind, event.createdAt, notBefore, ruleIds],
      );
    },
    groupsForPlayer: async (playerId: string): Promise<PlayerGroupRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT g.*, (SELECT count(*) FROM player_group_members m2 WHERE m2.group_id = g.id)::int AS member_count
         FROM player_groups g JOIN player_group_members m ON m.group_id = g.id
         WHERE m.player_id = $1 ORDER BY g.name`, [playerId],
      );
      return rows.map(toPlayerGroup);
    },
  };

  broadcast = {
    getConfig: async (serverId: string): Promise<BroadcastConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM broadcast_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toBroadcastConfig(rows[0]) : null;
    },
    listConfigs: async (): Promise<BroadcastConfigRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM broadcast_config");
      return rows.map(toBroadcastConfig);
    },
    upsertConfig: async (serverId: string, patch: BroadcastConfigPatch): Promise<BroadcastConfigRow> => {
      const existing = await this.broadcast.getConfig(serverId);
      const c = { ...BROADCAST_DEFAULTS, ...(existing ?? {}), ...patch };
      const { rows } = await this.pool.query(
        `INSERT INTO broadcast_config (server_id, enabled, dry_run, interval_sec, randomize, messages, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled=EXCLUDED.enabled, dry_run=EXCLUDED.dry_run, interval_sec=EXCLUDED.interval_sec,
           randomize=EXCLUDED.randomize, messages=EXCLUDED.messages, updated_at=now()
         RETURNING *`,
        [serverId, c.enabled, c.dryRun, c.intervalSec, c.randomize, JSON.stringify(c.messages)],
      );
      return toBroadcastConfig(rows[0]);
    },
  };

  gameRewards = {
    getConfig: async (serverId: string): Promise<GameRewardsConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM game_rewards_config WHERE server_id = $1", [serverId]);
      return rows[0] ? { serverId, config: mergeGameRewards(rows[0].config), updatedAt: new Date(rows[0].updated_at).toISOString() } : null;
    },
    setConfig: async (serverId: string, config: GameRewardsConfig): Promise<GameRewardsConfigRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO game_rewards_config (server_id, config, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (server_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now() RETURNING *`,
        [serverId, JSON.stringify(config)],
      );
      return { serverId, config: mergeGameRewards(rows[0].config), updatedAt: new Date(rows[0].updated_at).toISOString() };
    },
    claim: async (input: { serverId: string; playerId: string; ref: string; kind: string; detail?: Record<string, unknown> | null }): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        `INSERT INTO game_reward_receipts (server_id, player_id, ref, kind, detail) VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT DO NOTHING`,
        [input.serverId, input.playerId, input.ref, input.kind, input.detail ? JSON.stringify(input.detail) : null],
      );
      return (rowCount ?? 0) > 0;
    },
    release: async (input: { serverId: string; playerId: string; ref: string }): Promise<void> => {
      await this.pool.query(`DELETE FROM game_reward_receipts WHERE server_id = $1 AND ref = $2 AND player_id = $3`, [input.serverId, input.ref, input.playerId]);
    },
    addDaySeconds: async (serverId: string, kind: string, day: string, adds: { playerId: string; seconds: number }[]): Promise<{ playerId: string; seconds: number }[]> => {
      // One statement for the whole roster; duplicate ids pre-summed so no row is touched twice.
      const summed = new Map<string, number>();
      for (const a of adds) if (a.playerId && a.seconds > 0) summed.set(a.playerId, (summed.get(a.playerId) ?? 0) + Math.round(a.seconds));
      if (!summed.size) return [];
      const ids = [...summed.keys()].sort();
      const { rows } = await this.pool.query(
        `INSERT INTO game_reward_days (server_id, player_id, kind, day, seconds)
         SELECT $1, t.pid, $2, $3::date, t.secs FROM unnest($4::text[], $5::int[]) AS t(pid, secs)
         ON CONFLICT (server_id, player_id, kind, day) DO UPDATE SET seconds = game_reward_days.seconds + EXCLUDED.seconds
         RETURNING player_id, seconds`,
        [serverId, kind, day, ids, ids.map((i) => summed.get(i)!)],
      );
      return rows.map((r: any) => ({ playerId: r.player_id as string, seconds: Number(r.seconds) }));
    },
    days: async (serverId: string, playerId: string, kind: string, sinceDay: string): Promise<{ day: string; seconds: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, seconds FROM game_reward_days
          WHERE server_id = $1 AND player_id = $2 AND kind = $3 AND day >= $4::date ORDER BY day`,
        [serverId, playerId, kind, sinceDay],
      );
      return rows.map((r: any) => ({ day: r.day as string, seconds: Number(r.seconds) }));
    },
  };

  welcome = {
    getConfig: async (serverId: string): Promise<WelcomeConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM welcome_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toWelcomeConfig(rows[0]) : null;
    },
    upsertConfig: async (serverId: string, patch: WelcomeConfigPatch): Promise<WelcomeConfigRow> => {
      const existing = await this.welcome.getConfig(serverId);
      const c = { ...WELCOME_DEFAULTS, ...(existing ?? {}), ...patch };
      // Switched on, or the text changed: forget what was last written, so the next pass writes
      // even if the fill happens to match (the game may hold something else by now).
      const reset = !existing || existing.enabled !== c.enabled || existing.template !== c.template;
      const { rows } = await this.pool.query(
        `INSERT INTO welcome_config (server_id, enabled, template, interval_sec, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled = EXCLUDED.enabled, template = EXCLUDED.template, interval_sec = EXCLUDED.interval_sec, updated_at = now(),
           last_text = CASE WHEN $5::boolean THEN NULL ELSE welcome_config.last_text END
         RETURNING *`,
        [serverId, c.enabled, c.template, c.intervalSec, reset],
      );
      return toWelcomeConfig(rows[0]);
    },
    markWritten: async (serverId: string, text: string | null, at: string | null): Promise<void> => {
      await this.pool.query("UPDATE welcome_config SET last_text = $2, last_written_at = COALESCE($3, last_written_at) WHERE server_id = $1", [serverId, text, at]);
    },
  };

  discordRelay = {
    getConfig: async (serverId: string): Promise<DiscordRelayConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM discord_relay_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toDiscordRelayConfig(rows[0]) : null;
    },
    listConfigs: async (): Promise<DiscordRelayConfigRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM discord_relay_config");
      return rows.map(toDiscordRelayConfig);
    },
    upsertConfig: async (serverId: string, patch: DiscordRelayConfigPatch): Promise<DiscordRelayConfigRow> => {
      const existing = await this.discordRelay.getConfig(serverId);
      const c = { ...DISCORD_RELAY_DEFAULTS, ...(existing ?? {}), ...patch };
      const { rows } = await this.pool.query(
        `INSERT INTO discord_relay_config (server_id, enabled, categories, channels, category_options, alerts, status_board, updated_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled=EXCLUDED.enabled, categories=EXCLUDED.categories, channels=EXCLUDED.channels,
           category_options=EXCLUDED.category_options, alerts=EXCLUDED.alerts,
           status_board=EXCLUDED.status_board, updated_at=now()
         RETURNING *`,
        [serverId, c.enabled, JSON.stringify(c.categories), JSON.stringify(c.channels), JSON.stringify(c.categoryOptions ?? {}), JSON.stringify(c.alerts ?? DISCORD_ALERTS_DEFAULTS), JSON.stringify(c.statusBoard ?? DISCORD_STATUS_BOARD_DEFAULTS)],
      );
      return toDiscordRelayConfig(rows[0]);
    },
    patchBoardState: async (serverId: string, state: { messageId: string | null; imageName: string | null }): Promise<void> => {
      // A jsonb merge IN the database, not a read-modify-write in the process: the worker calls
      // this holding a config snapshot that is seconds old, and everything else on the row — and
      // every other key of status_board, including the operator's title — must survive whatever
      // was saved in the meantime. `||` only replaces the two keys named here.
      await this.pool.query(
        `UPDATE discord_relay_config
            SET status_board = status_board || jsonb_build_object('messageId', $2::text, 'imageName', $3::text),
                updated_at = now()
          WHERE server_id = $1`,
        [serverId, state.messageId, state.imageName],
      );
    },
  };

  autosettings = {
    getConfig: async (serverId: string): Promise<AutoSettingsConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM autosettings_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toAutoSettingsConfig(rows[0]) : null;
    },
    listConfigs: async (): Promise<AutoSettingsConfigRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM autosettings_config");
      return rows.map(toAutoSettingsConfig);
    },
    upsertConfig: async (serverId: string, patch: AutoSettingsConfigPatch): Promise<AutoSettingsConfigRow> => {
      const existing = await this.autosettings.getConfig(serverId);
      const c = { ...AUTOSETTINGS_DEFAULTS, ...(existing ?? {}), ...patch };
      // The legacy `modules` column is deliberately absent: migration 072 translated the module
      // blobs onto enforcer rules and keeps the column as its untouched recovery record.
      const { rows } = await this.pool.query(
        `INSERT INTO autosettings_config (server_id, enabled, dry_run, timezone, profiles, match_messages, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled=EXCLUDED.enabled, dry_run=EXCLUDED.dry_run, timezone=EXCLUDED.timezone,
           profiles=EXCLUDED.profiles, match_messages=EXCLUDED.match_messages, updated_at=now()
         RETURNING *`,
        [serverId, c.enabled, c.dryRun, c.timezone, JSON.stringify(c.profiles), JSON.stringify(c.matchMessages ?? [])],
      );
      return toAutoSettingsConfig(rows[0]);
    },
    templates: {
      list: async (): Promise<AutoSettingsTemplateRow[]> => {
        const { rows } = await this.pool.query("SELECT * FROM autosettings_templates ORDER BY lower(name)");
        return rows.map(toAutoSettingsTemplate);
      },
      get: async (name: string): Promise<AutoSettingsTemplateRow | null> => {
        const { rows } = await this.pool.query("SELECT * FROM autosettings_templates WHERE lower(name) = lower($1)", [name]);
        return rows[0] ? toAutoSettingsTemplate(rows[0]) : null;
      },
      save: async (input: { name: string; config: AutoSettingsTemplateRow["config"]; createdByName: string }): Promise<AutoSettingsTemplateRow> => {
        const { rows } = await this.pool.query(
          `INSERT INTO autosettings_templates (id, name, config, created_by_name, updated_at)
           VALUES ($1,$2,$3::jsonb,$4, now())
           ON CONFLICT (lower(name)) DO UPDATE SET
             name=EXCLUDED.name, config=EXCLUDED.config, created_by_name=EXCLUDED.created_by_name, updated_at=now()
           RETURNING *`,
          [randomUUID(), input.name, JSON.stringify(input.config), input.createdByName],
        );
        return toAutoSettingsTemplate(rows[0]);
      },
      remove: async (id: string): Promise<boolean> => {
        const { rowCount } = await this.pool.query("DELETE FROM autosettings_templates WHERE id = $1", [id]);
        return (rowCount ?? 0) > 0;
      },
    },
  };

  seeding = {
    getConfig: async (serverId: string): Promise<SeedingConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM seeding_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toSeedingConfig(rows[0]) : null;
    },
    listConfigs: async (): Promise<SeedingConfigRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM seeding_config");
      return rows.map(toSeedingConfig);
    },
    upsertConfig: async (serverId: string, patch: SeedingConfigPatch): Promise<SeedingConfigRow> => {
      const existing = await this.seeding.getConfig(serverId);
      const c = { ...SEEDING_DEFAULTS, ...(existing ?? {}), ...patch };
      const { rows } = await this.pool.query(
        `INSERT INTO seeding_config (server_id, enabled, dry_run, seed_target, min_players, disallowed_roles,
           disallowed_weapon_classes, disallowed_weapons, disallowed_weapon_names, disallowed_commander_abilities,
           cap_fight_enabled, cap_fight_max_caps, cap_fight_skip_warning, cap_fight_notice,
           contain_enabled, contain_auto_enabled, contain_grace_sec, contain_max_players, contain_notice, contain_zones,
           pace_enabled, pace_unlock_minutes, pace_notice,
           immune_level, immune_tags, announce_message, max_warnings, warn_interval_sec, warn_message,
           max_punishes, punish_interval_sec, punish_message, kick_after, kick_message,
           reward_enabled, reward_hours, reward_points, min_seed_minutes, reward_cumulative, reward_message,
           reward_linked_note, reward_unlinked_note, reward_delay_sec,
           phase_confirm_sec, phase_hysteresis, reward_bridge, layout_learn_enabled, check_sec, chase_check_sec, reward_repeat_message, positional_enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22::jsonb,$23,$24,$25::jsonb,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46::jsonb,$47,$48,$49,$50,$51, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled=EXCLUDED.enabled, dry_run=EXCLUDED.dry_run, seed_target=EXCLUDED.seed_target,
           min_players=EXCLUDED.min_players, disallowed_roles=EXCLUDED.disallowed_roles,
           disallowed_weapon_classes=EXCLUDED.disallowed_weapon_classes, disallowed_weapons=EXCLUDED.disallowed_weapons,
           disallowed_weapon_names=EXCLUDED.disallowed_weapon_names, disallowed_commander_abilities=EXCLUDED.disallowed_commander_abilities,
           cap_fight_enabled=EXCLUDED.cap_fight_enabled, cap_fight_max_caps=EXCLUDED.cap_fight_max_caps,
           cap_fight_skip_warning=EXCLUDED.cap_fight_skip_warning, cap_fight_notice=EXCLUDED.cap_fight_notice,
           contain_enabled=EXCLUDED.contain_enabled, contain_auto_enabled=EXCLUDED.contain_auto_enabled, contain_grace_sec=EXCLUDED.contain_grace_sec,
           pace_enabled=EXCLUDED.pace_enabled, pace_unlock_minutes=EXCLUDED.pace_unlock_minutes, pace_notice=EXCLUDED.pace_notice,
           contain_max_players=EXCLUDED.contain_max_players, contain_notice=EXCLUDED.contain_notice,
           contain_zones=EXCLUDED.contain_zones,
           immune_level=EXCLUDED.immune_level, immune_tags=EXCLUDED.immune_tags, announce_message=EXCLUDED.announce_message,
           max_warnings=EXCLUDED.max_warnings, warn_interval_sec=EXCLUDED.warn_interval_sec, warn_message=EXCLUDED.warn_message,
           max_punishes=EXCLUDED.max_punishes, punish_interval_sec=EXCLUDED.punish_interval_sec, punish_message=EXCLUDED.punish_message,
           kick_after=EXCLUDED.kick_after, kick_message=EXCLUDED.kick_message,
           reward_enabled=EXCLUDED.reward_enabled, reward_hours=EXCLUDED.reward_hours, reward_points=EXCLUDED.reward_points,
           min_seed_minutes=EXCLUDED.min_seed_minutes,
           reward_cumulative=EXCLUDED.reward_cumulative, reward_message=EXCLUDED.reward_message,
           reward_linked_note=EXCLUDED.reward_linked_note, reward_unlinked_note=EXCLUDED.reward_unlinked_note,
           reward_delay_sec=EXCLUDED.reward_delay_sec, phase_confirm_sec=EXCLUDED.phase_confirm_sec,
           phase_hysteresis=EXCLUDED.phase_hysteresis, reward_bridge=EXCLUDED.reward_bridge,
           layout_learn_enabled=EXCLUDED.layout_learn_enabled,
           check_sec=EXCLUDED.check_sec, chase_check_sec=EXCLUDED.chase_check_sec,
           reward_repeat_message=EXCLUDED.reward_repeat_message, positional_enabled=EXCLUDED.positional_enabled, updated_at=now()
         RETURNING *`,
        [serverId, c.enabled, c.dryRun, c.seedTarget, c.minPlayers, JSON.stringify(c.disallowedRoles),
         JSON.stringify(c.disallowedWeaponClasses ?? []), JSON.stringify(c.disallowedWeapons ?? []),
         JSON.stringify(c.disallowedWeaponNames ?? []), JSON.stringify(c.disallowedCommanderAbilities ?? []),
         c.capFightEnabled ?? false, c.capFightMaxCaps ?? 3, c.capFightSkipWarning ?? false, c.capFightNotice ?? "",
         c.containEnabled ?? false, c.containAutoEnabled ?? false, c.containGraceSec ?? 60, c.containMaxPlayers ?? 60, c.containNotice ?? "",
         JSON.stringify(c.containZones ?? {}),
         c.paceEnabled ?? false, JSON.stringify(c.paceUnlockMinutes ?? [0, 0, 20, 40, 60]), c.paceNotice ?? "",
         c.immuneLevel, JSON.stringify(c.immuneTags), c.announceMessage, c.maxWarnings, c.warnIntervalSec, c.warnMessage,
         c.maxPunishes, c.punishIntervalSec, c.punishMessage, c.kickAfter, c.kickMessage,
         c.rewardEnabled, c.rewardHours, c.rewardPoints ?? 0, c.minSeedMinutes, c.rewardCumulative, c.rewardMessage,
         c.rewardLinkedNote ?? "", c.rewardUnlinkedNote ?? "", c.rewardDelaySec,
         c.phaseConfirmSec, c.phaseHysteresis, JSON.stringify(c.rewardBridge ?? []), c.layoutLearnEnabled ?? true,
         c.checkSec ?? null, c.chaseCheckSec ?? null, c.rewardRepeatMessage ?? SEEDING_DEFAULTS.rewardRepeatMessage, c.positionalEnabled ?? false],
      );
      return toSeedingConfig(rows[0]);
    },
    addProgress: async (serverId: string, playerId: string, playerName: string | null, deltaSeconds: number): Promise<void> => {
      await this.pool.query(
        `INSERT INTO seed_progress (server_id, player_id, player_name, seconds, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (server_id, player_id) DO UPDATE SET
           seconds = seed_progress.seconds + EXCLUDED.seconds,
           player_name = COALESCE(EXCLUDED.player_name, seed_progress.player_name),
           updated_at = now()`,
        [serverId, playerId, playerName, Math.max(0, Math.round(deltaSeconds))],
      );
    },
    addProgressMany: async (serverId: string, adds: { playerId: string; playerName: string | null; deltaSeconds: number }[]): Promise<void> => {
      if (!adds.length) return;
      // Pre-sum duplicates: two entries for one player in a single INSERT would hit the same row
      // twice, which ON CONFLICT rejects outright. Sorted keys keep the same lock-order
      // discipline as every other batch upsert here, so concurrent ticks can't deadlock.
      const byId = new Map<string, { playerName: string | null; seconds: number }>();
      for (const a of adds) {
        const cur = byId.get(a.playerId);
        byId.set(a.playerId, {
          playerName: a.playerName ?? cur?.playerName ?? null,
          seconds: (cur?.seconds ?? 0) + Math.max(0, Math.round(a.deltaSeconds)),
        });
      }
      const rows = [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      await this.pool.query(
        `INSERT INTO seed_progress (server_id, player_id, player_name, seconds, updated_at)
         SELECT $1, u.player_id, u.player_name, u.seconds, now()
         FROM unnest($2::text[], $3::text[], $4::int[]) AS u(player_id, player_name, seconds)
         ON CONFLICT (server_id, player_id) DO UPDATE SET
           seconds = seed_progress.seconds + EXCLUDED.seconds,
           player_name = COALESCE(EXCLUDED.player_name, seed_progress.player_name),
           updated_at = now()`,
        [serverId, rows.map(([id]) => id), rows.map(([, r]) => r.playerName), rows.map(([, r]) => r.seconds)],
      );
    },
    listProgress: async (serverId: string): Promise<SeedProgressRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM seed_progress WHERE server_id = $1", [serverId]);
      return rows.map(toSeedProgress);
    },
    clearProgress: async (serverId: string): Promise<void> => {
      await this.pool.query("DELETE FROM seed_progress WHERE server_id = $1", [serverId]);
    },
    getState: async (serverId: string): Promise<SeedingStateRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM seeding_state WHERE server_id = $1", [serverId]);
      return rows[0] ? toSeedingState(rows[0]) : null;
    },
    setState: async (state: SeedingStateRow): Promise<void> => {
      await this.pool.query(
        `INSERT INTO seeding_state (server_id, phase, live_count, seeder_count, last_reward_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (server_id) DO UPDATE SET phase=EXCLUDED.phase, live_count=EXCLUDED.live_count, seeder_count=EXCLUDED.seeder_count, last_reward_at=EXCLUDED.last_reward_at, updated_at=now()`,
        [state.serverId, state.phase, state.liveCount, state.seederCount, state.lastRewardAt],
      );
    },
    setLastCycle: async (serverId: string, cycle: SeedCycleRecord): Promise<void> => {
      await this.pool.query(
        `INSERT INTO seeding_state (server_id, last_cycle) VALUES ($1, $2::jsonb)
         ON CONFLICT (server_id) DO UPDATE SET last_cycle = EXCLUDED.last_cycle`,
        [serverId, JSON.stringify(cycle)],
      );
    },
    getLastCycle: async (serverId: string): Promise<SeedCycleRecord | null> => {
      const { rows } = await this.pool.query("SELECT last_cycle FROM seeding_state WHERE server_id = $1", [serverId]);
      const c = rows[0]?.last_cycle;
      if (!c || typeof c !== "object" || !Array.isArray((c as { entries?: unknown }).entries)) return null;
      return c as SeedCycleRecord;
    },
    requestPay: async (serverId: string): Promise<void> => {
      await this.pool.query(
        `INSERT INTO seeding_state (server_id, pay_requested_at) VALUES ($1, now())
         ON CONFLICT (server_id) DO UPDATE SET pay_requested_at = now()`,
        [serverId],
      );
    },
    takePayRequest: async (serverId: string): Promise<boolean> => {
      const { rows } = await this.pool.query(
        "UPDATE seeding_state SET pay_requested_at = NULL WHERE server_id = $1 AND pay_requested_at IS NOT NULL RETURNING server_id",
        [serverId],
      );
      return rows.length > 0;
    },
  };

  mapLayouts = {
    list: async (): Promise<MapLayoutRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM map_layouts ORDER BY map_id");
      return rows.map(toMapLayout);
    },
    get: async (mapId: string): Promise<MapLayoutRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM map_layouts WHERE map_id = $1", [mapId.toLowerCase()]);
      return rows[0] ? toMapLayout(rows[0]) : null;
    },
    record: async (mapId: string, vote: { axis: "x" | "y"; alliesDir: -1 | 1; separation?: number; round?: string | null }): Promise<MapLayoutRow | null> => {
      const col = `${vote.axis}_${vote.alliesDir === -1 ? "neg" : "pos"}`;
      // The column is one of four fixed names built from a typed union — never user text. The
      // WHERE makes a repeat vote from the same match a no-op (no row returned).
      const { rows } = await this.pool.query(
        `INSERT INTO map_layouts (map_id, ${col}, separation, last_round, updated_at) VALUES ($1, 1, $2, $3, now())
         ON CONFLICT (map_id) DO UPDATE SET ${col} = map_layouts.${col} + 1, separation = $2, last_round = $3, updated_at = now()
           WHERE $3::text IS NULL OR map_layouts.last_round IS DISTINCT FROM $3::text
         RETURNING *`,
        [mapId.toLowerCase(), Math.round(vote.separation ?? 0), vote.round ?? null],
      );
      return rows[0] ? toMapLayout(rows[0]) : null;
    },
  };


  objectivePoints = {
    forMap: async (game: string, mapKey: string): Promise<ObjectivePointRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM objective_points WHERE game = $1 AND map_key = $2", [game, mapKey]);
      return rows.map(toObjectivePoint);
    },
    // Read-modify-write: teaching is rare, and the patch rule (omitted keeps, blank clears,
    // empty drops) reads clearest as one place computing the next row.
    set: async (game: string, mapKey: string, row: number, idx: number, patch: { name?: string | null; sector?: string | null }): Promise<ObjectivePointRow | null> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM objective_points WHERE game = $1 AND map_key = $2 AND row_no = $3 AND idx = $4", [game, mapKey, row, idx]);
      const existing = rows[0] ? toObjectivePoint(rows[0]) : null;
      const name = patch.name !== undefined ? (String(patch.name ?? "").trim() || null) : existing?.name ?? null;
      const sector = patch.sector !== undefined ? (String(patch.sector ?? "").trim() || null) : existing?.sector ?? null;
      if (name === null && sector === null) {
        await this.pool.query("DELETE FROM objective_points WHERE game = $1 AND map_key = $2 AND row_no = $3 AND idx = $4", [game, mapKey, row, idx]);
        return null;
      }
      const up = await this.pool.query(
        `INSERT INTO objective_points (game, map_key, row_no, idx, name, sector, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (game, map_key, row_no, idx) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector, updated_at = now()
         RETURNING *`,
        [game, mapKey, row, idx, name, sector]);
      return toObjectivePoint(up.rows[0]);
    },
  };

  layoutExpiries = {
    list: async (): Promise<ObjectiveLayoutExpiryRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM objective_layout_expiries");
      return rows.map(toLayoutExpiry);
    },
    get: async (serverId: string, mapId: string): Promise<ObjectiveLayoutExpiryRow | null> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM objective_layout_expiries WHERE server_id = $1 AND map_id = $2", [serverId, mapId]);
      return rows[0] ? toLayoutExpiry(rows[0]) : null;
    },
    set: async (input: { serverId: string; mapId: string; playsLeft: number; lastMatchId: string | null; setBy: string }): Promise<ObjectiveLayoutExpiryRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO objective_layout_expiries (server_id, map_id, plays_left, last_match_id, set_by, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (server_id, map_id) DO UPDATE SET plays_left = EXCLUDED.plays_left, last_match_id = EXCLUDED.last_match_id, set_by = EXCLUDED.set_by, updated_at = now()
         RETURNING *`,
        [input.serverId, input.mapId, input.playsLeft, input.lastMatchId, input.setBy]);
      return toLayoutExpiry(rows[0]);
    },
    count: async (serverId: string, mapId: string, playsLeft: number, lastMatchId: string): Promise<void> => {
      await this.pool.query(
        "UPDATE objective_layout_expiries SET plays_left = $3, last_match_id = $4, updated_at = now() WHERE server_id = $1 AND map_id = $2",
        [serverId, mapId, playsLeft, lastMatchId]);
    },
    delete: async (serverId: string, mapId: string): Promise<void> => {
      await this.pool.query("DELETE FROM objective_layout_expiries WHERE server_id = $1 AND map_id = $2", [serverId, mapId]);
    },
  };

  // What the removed objective presets may have left (see the Repository's mapPointPending).
  mapPointPending = {
    list: async (): Promise<MapPointPendingRow[]> => {
      const { rows } = await this.pool.query(`SELECT * FROM map_point_pending ORDER BY requested_at, server_id COLLATE "C"`);
      return rows.map(toMapPointPending);
    },
    take: async (serverId: string, id: string): Promise<MapPointPendingRow | null> => {
      const { rows } = await this.pool.query("DELETE FROM map_point_pending WHERE server_id = $1 AND id = $2 RETURNING *", [serverId, id]);
      return rows[0] ? toMapPointPending(rows[0]) : null;
    },
  };

  mapNames = {
    list: async (game: string): Promise<MapNameRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM map_names WHERE game = $1", [game]);
      return rows.map(toMapName);
    },
    set: (game: string, mapId: string, displayName: string) => this.setMapOverride(game, mapId, "display_name", displayName),
    setFamily: (game: string, mapId: string, family: string) => this.setMapOverride(game, mapId, "family", family),
  };

  /**
   * One column of a map's overrides. Clearing the last one deletes the row rather than leaving a
   * pair of nulls behind, so `list` stays a list of maps that actually carry an override — but
   * clearing one while the OTHER is still set must keep the row, which is why this cannot simply
   * delete on blank the way it did when the name was the only override there was.
   */
  private async setMapOverride(game: string, mapId: string, column: "display_name" | "family", value: string): Promise<MapNameRow | null> {
    const v = value.trim();
    const other = column === "display_name" ? "family" : "display_name";
    if (!v) {
      const { rows } = await this.pool.query(
        `UPDATE map_names SET ${column} = NULL, updated_at = now() WHERE game = $1 AND map_id = $2 RETURNING *`,
        [game, mapId],
      );
      if (!rows[0]) return null;
      if (rows[0][other] === null) {
        await this.pool.query("DELETE FROM map_names WHERE game = $1 AND map_id = $2", [game, mapId]);
        return null;
      }
      return toMapName(rows[0]);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO map_names (game, map_id, ${column}, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (game, map_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()
       RETURNING *`,
      [game, mapId, v],
    );
    return toMapName(rows[0]);
  }

  /**
   * Narrow + order an admin-cam read. Sorting lives in SQL because the list is paged: sorting the
   * twenty rows on screen is not sorting the history, and "who spent longest in cam" is exactly
   * the question a page-local sort answers wrongly.
   */
  private adminCamWhere(q: AdminCamQuery): { sql: string; args: unknown[]; order: string } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.serverId) { args.push(q.serverId); where.push(`s.server_id = $${args.length}`); }
    // An empty allow-list means the viewer may see nothing — `= ANY('{}')` says exactly that.
    if (q.serverIds) { args.push(q.serverIds); where.push(`s.server_id = ANY($${args.length})`); }
    if (q.playerId) { args.push(q.playerId); where.push(`s.player_id = $${args.length}`); }
    if (q.q) { args.push(containsLike(q.q)); where.push(`s.player_name ILIKE $${args.length}`); }
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    // NULLS LAST in both directions: an open session has no exit and no duration, and it belongs
    // beside the newest rows rather than sorted as if it were zero seconds long.
    const by: Record<string, string> = {
      entered: `s.entered_at ${dir}`,
      exited: `s.exited_at ${dir} NULLS LAST`,
      duration: `s.duration_sec ${dir} NULLS LAST`,
      who: `lower(s.player_name) ${dir}`,
      server: `lower(v.name) ${dir}, s.entered_at DESC`,
    };
    // id breaks ties so a page boundary can neither repeat a row nor skip one.
    const order = `${by[q.sort ?? "entered"] ?? by.entered}, s.id ${dir}`;
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args, order };
  }

  signatures = {
    get: async (): Promise<SignatureConfigRow> => {
      const { rows } = await this.pool.query("SELECT * FROM signature_config WHERE id = true");
      // The migration seeds the row, but a store that answers `null` for "nothing configured yet"
      // would push that case onto every caller — including the action path, mid-kick.
      return rows[0] ? toSignatureConfig(rows[0]) : { ...SIGNATURE_DEFAULTS, updatedAt: new Date(0).toISOString() };
    },
    set: async (patch: SignatureConfigPatch): Promise<SignatureConfigRow> => {
      const e = await this.signatures.get();
      const { rows } = await this.pool.query(
        `INSERT INTO signature_config (id, staff_line, custom_line, actions, updated_at)
         VALUES (true, $1, $2, $3::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           staff_line=EXCLUDED.staff_line, custom_line=EXCLUDED.custom_line,
           actions=EXCLUDED.actions, updated_at=now()
         RETURNING *`,
        [patch.staffLine ?? e.staffLine, patch.customLine ?? e.customLine,
         JSON.stringify(patch.actions ?? e.actions)],
      );
      return toSignatureConfig(rows[0]);
    },
  };

  adminCam = {
    open: async (input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<void> => {
      // A re-read of the same log window must not open a second session on top of the first, and
      // the log window IS re-read: the poll backtracks a few seconds every tick and the whole
      // window again after a reconnect.
      //
      // The one-open-per-(server, player) unique index cannot carry that guarantee alone, because
      // Postgres treats NULLs as distinct in a unique index. A camera line with no resolvable
      // player id — routine on this server, see the corrupted-id repair — conflicts with nothing,
      // so ON CONFLICT DO NOTHING never fired and every poll opened another session that the
      // matching exit could only ever close one of. The leftovers read as "still in cam" forever.
      //
      // So the existence check is explicit and matches `close` exactly: on the player when we have
      // one, on the NAME when we do not. The index stays as the race backstop for the id case.
      await this.pool.query(
        `INSERT INTO admin_cam_sessions (server_id, player_id, player_name, entered_at)
         SELECT $1,$2::uuid,$3,$4::timestamptz
         WHERE NOT EXISTS (
           SELECT 1 FROM admin_cam_sessions
           WHERE server_id = $1 AND exited_at IS NULL
             AND ($2::uuid IS NOT NULL AND player_id = $2 OR $2::uuid IS NULL AND player_name = $3)
         )
         ON CONFLICT DO NOTHING`,
        [input.serverId, input.playerId, input.playerName, input.at],
      );
    },
    close: async (input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<number | null> => {
      // Matched on the player when we have one, on the name when we do not — an id-less log line
      // must still be able to close the session its own entry opened.
      const { rows } = await this.pool.query(
        `UPDATE admin_cam_sessions SET exited_at = $3,
           duration_sec = GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - entered_at))::int)
         WHERE id = (
           SELECT id FROM admin_cam_sessions
           WHERE server_id = $1 AND exited_at IS NULL
             AND ($2::uuid IS NOT NULL AND player_id = $2 OR $2::uuid IS NULL AND player_name = $4)
           ORDER BY entered_at DESC LIMIT 1
         )
         RETURNING duration_sec`,
        [input.serverId, input.playerId, input.at, input.playerName],
      );
      return rows[0] ? Number(rows[0].duration_sec) : null;
    },
    /**
     * A COMPLETE visit, both ends known up front — how the CRCON archive importer writes history.
     *
     * Not open()+close(). Those are for the live path, which learns the two halves minutes apart
     * and therefore has to leave a session hanging in between. Replaying them over an archive
     * looks right and is not: on a second apply the earlier visit is already CLOSED, so `open`
     * sees nothing open, starts a fresh one, and `close` finishes it — one duplicate visit per
     * pair, per re-apply. Re-applying an archive is the normal retry workflow here, so that is a
     * duplicate every time somebody retries a pull.
     *
     * Keyed on (server, entered_at, whoever) instead: the same enter instant is the same visit,
     * so a re-apply is a no-op and an instance that imported before this existed still gets its
     * history rebuilt. Player id when there is one, name when there is not — the same fallback
     * `open`/`close` already use, because old CRCON eras logged camera lines without an id.
     */
    importOne: async (input: { serverId: string; playerId: string | null; playerName: string; enteredAt: string; exitedAt: string; durationSec: number }): Promise<boolean> => {
      const r = await this.pool.query(
        `INSERT INTO admin_cam_sessions (server_id, player_id, player_name, entered_at, exited_at, duration_sec)
         SELECT $1,$2::uuid,$3,$4::timestamptz,$5::timestamptz,$6
         WHERE NOT EXISTS (
           SELECT 1 FROM admin_cam_sessions
           WHERE server_id = $1 AND entered_at = $4::timestamptz
             AND ($2::uuid IS NOT NULL AND player_id = $2 OR $2::uuid IS NULL AND player_name = $3)
         )`,
        [input.serverId, input.playerId, input.playerName, input.enteredAt, input.exitedAt, input.durationSec],
      );
      return (r.rowCount ?? 0) > 0;
    },
    list: async (query: AdminCamQuery = {}): Promise<AdminCamSessionRow[]> => {
      const { sql, args, order } = this.adminCamWhere(query);
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
      args.push(limit); const lim = args.length;
      args.push(Math.max(query.offset ?? 0, 0)); const off = args.length;
      const { rows } = await this.pool.query(
        `SELECT s.* FROM admin_cam_sessions s JOIN servers v ON v.id = s.server_id
         ${sql} ORDER BY ${order} LIMIT $${lim} OFFSET $${off}`,
        args,
      );
      return rows.map(toAdminCamSession);
    },
    count: async (query: AdminCamQuery = {}): Promise<number> => {
      const { sql, args } = this.adminCamWhere(query);
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM admin_cam_sessions s JOIN servers v ON v.id = s.server_id ${sql}`,
        args,
      );
      return Number(rows[0]?.n ?? 0);
    },
    admins: async (serverIds?: string[]): Promise<{ playerId: string | null; playerName: string }[]> => {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT ON (lower(player_name)) player_id, player_name FROM admin_cam_sessions
         ${serverIds ? "WHERE server_id = ANY($1)" : ""}
         ORDER BY lower(player_name)`,
        serverIds ? [serverIds] : [],
      );
      return rows.map((r) => ({ playerId: r.player_id ?? null, playerName: r.player_name }));
    },
    getConfig: async (serverId: string): Promise<AdminCamConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM admin_cam_config WHERE server_id = $1", [serverId]);
      return rows[0] ? toAdminCamConfig(rows[0]) : null;
    },
    setConfig: async (serverId: string, patch: AdminCamConfigPatch): Promise<AdminCamConfigRow> => {
      const e = await this.adminCam.getConfig(serverId);
      const c = {
        notifyEnabled: patch.notifyEnabled ?? e?.notifyEnabled ?? ADMIN_CAM_DEFAULTS.notifyEnabled,
        enterMessage: patch.enterMessage ?? e?.enterMessage ?? ADMIN_CAM_DEFAULTS.enterMessage,
        exitMessage: patch.exitMessage ?? e?.exitMessage ?? ADMIN_CAM_DEFAULTS.exitMessage,
      };
      const { rows } = await this.pool.query(
        `INSERT INTO admin_cam_config (server_id, notify_enabled, enter_message, exit_message, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (server_id) DO UPDATE SET
           notify_enabled=EXCLUDED.notify_enabled, enter_message=EXCLUDED.enter_message,
           exit_message=EXCLUDED.exit_message, updated_at=now()
         RETURNING *`,
        [serverId, c.notifyEnabled, c.enterMessage, c.exitMessage],
      );
      return toAdminCamConfig(rows[0]);
    },
  };

  mapSets = {
    list: async (game?: string): Promise<MapSetRow[]> => {
      const { rows } = game
        ? await this.pool.query("SELECT * FROM map_sets WHERE game = $1 ORDER BY lower(name)", [game])
        : await this.pool.query("SELECT * FROM map_sets ORDER BY lower(name)");
      return rows.map(toMapSet);
    },
    get: async (id: string): Promise<MapSetRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM map_sets WHERE id = $1", [id]);
      return rows[0] ? toMapSet(rows[0]) : null;
    },
    findByName: async (name: string): Promise<MapSetRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM map_sets WHERE lower(name) = lower($1)", [name]);
      return rows[0] ? toMapSet(rows[0]) : null;
    },
    create: async (input: { id?: string; name: string; game: string; pool?: Record<string, unknown> }): Promise<MapSetRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO map_sets (id, name, game, pool) VALUES (COALESCE($4::uuid, gen_random_uuid()), $1, $2, $3::jsonb) RETURNING *",
        [input.name.trim(), input.game, JSON.stringify(input.pool ?? {}), input.id ?? null],
      );
      return toMapSet(rows[0]);
    },
    update: async (id: string, patch: { name?: string; game?: string; pool?: Record<string, unknown> }): Promise<MapSetRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE map_sets SET name = COALESCE($2, name), game = COALESCE($3, game),
                             pool = COALESCE($4::jsonb, pool), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.name === undefined ? null : patch.name.trim(), patch.game ?? null,
         patch.pool === undefined ? null : JSON.stringify(patch.pool)],
      );
      return rows[0] ? toMapSet(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM map_sets WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  mapZones = {
    list: async (game?: string): Promise<MapZoneSetRow[]> => {
      const { rows } = game
        ? await this.pool.query("SELECT * FROM map_zone_sets WHERE game = $1 ORDER BY lower(name)", [game])
        : await this.pool.query("SELECT * FROM map_zone_sets ORDER BY lower(name)");
      return rows.map(toMapZoneSet);
    },
    get: async (id: string): Promise<MapZoneSetRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM map_zone_sets WHERE id = $1", [id]);
      return rows[0] ? toMapZoneSet(rows[0]) : null;
    },
    create: async (input: { name: string; game: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO map_zone_sets (name, game, zones) VALUES ($1, $2, $3::jsonb) RETURNING *",
        [input.name.trim(), input.game, JSON.stringify(input.zones ?? {})],
      );
      return toMapZoneSet(rows[0]);
    },
    update: async (id: string, patch: { name?: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE map_zone_sets SET name = COALESCE($2, name), zones = COALESCE($3::jsonb, zones), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.name === undefined ? null : patch.name.trim(), patch.zones === undefined ? null : JSON.stringify(patch.zones)],
      );
      return rows[0] ? toMapZoneSet(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM map_zone_sets WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  voteSchedules = {
    list: async (): Promise<VoteScheduleRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM vote_schedules ORDER BY lower(name)");
      return rows.map(toVoteSchedule);
    },
    get: async (id: string): Promise<VoteScheduleRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM vote_schedules WHERE id = $1", [id]);
      return rows[0] ? toVoteSchedule(rows[0]) : null;
    },
    findByName: async (name: string): Promise<VoteScheduleRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM vote_schedules WHERE lower(name) = lower($1)", [name]);
      return rows[0] ? toVoteSchedule(rows[0]) : null;
    },
    create: async (input: { id?: string; name: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow> => {
      const { rows } = await this.pool.query(
        "INSERT INTO vote_schedules (id, name, spec) VALUES (COALESCE($3::uuid, gen_random_uuid()), $1, $2::jsonb) RETURNING *",
        [input.name.trim(), JSON.stringify(input.spec ?? {}), input.id ?? null],
      );
      return toVoteSchedule(rows[0]);
    },
    update: async (id: string, patch: { name?: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow | null> => {
      const { rows } = await this.pool.query(
        `UPDATE vote_schedules SET name = COALESCE($2, name), spec = COALESCE($3::jsonb, spec), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.name === undefined ? null : patch.name.trim(), patch.spec === undefined ? null : JSON.stringify(patch.spec)],
      );
      return rows[0] ? toVoteSchedule(rows[0]) : null;
    },
    remove: async (id: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM vote_schedules WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };

  /** Both libraries in one round trip. `listConfigs` is a worker scan across every server, so this
   *  is read once for the whole scan rather than twice per server. */
  private async mapVoteLibrary(): Promise<MapVoteLibrary> {
    const [sets, schedules] = await Promise.all([this.mapSets.list(), this.voteSchedules.list()]);
    return { sets, schedules };
  }

  mapVote = {
    getConfig: async (serverId: string): Promise<MapVoteConfigRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM mapvote_config WHERE server_id = $1", [serverId]);
      if (!rows[0]) return null;
      return toMapVoteConfig(rows[0], await this.mapVoteLibrary());
    },
    listConfigs: async (): Promise<MapVoteConfigRow[]> => {
      const [{ rows }, library] = await Promise.all([this.pool.query("SELECT * FROM mapvote_config"), this.mapVoteLibrary()]);
      return rows.map((r) => toMapVoteConfig(r, library));
    },
    setConfig: async (serverId: string, patch: MapVoteConfigPatch): Promise<MapVoteConfigRow> => {
      const e = await this.mapVote.getConfig(serverId);
      const c = {
        enabled: patch.enabled ?? e?.enabled ?? false,
        surface: patch.surface ?? e?.surface ?? "native",
        channelId: patch.channelId !== undefined ? patch.channelId : e?.channelId ?? null,
        pollHours: patch.pollHours ?? e?.pollHours ?? 24,
        timezone: patch.timezone ?? e?.timezone ?? "UTC",
        // `e.profiles` is the HYDRATED read; the pairings are what the column holds, so an
        // untouched patch has to carry those forward or a save of any other field would flatten
        // the links into resolved copies and un-share every set on this server.
        profiles: patch.profiles ?? e?.profileLinks ?? [],
        reminders: patch.reminders ?? e?.reminders ?? [],
        liveApply: patch.liveApply ?? e?.liveApply ?? true,
        postMatchApplyDelaySeconds: patch.postMatchApplyDelaySeconds ?? e?.postMatchApplyDelaySeconds ?? 300,
        pollResetDelaySeconds: patch.pollResetDelaySeconds ?? e?.pollResetDelaySeconds ?? 180,
        tidyChannel: patch.tidyChannel ?? e?.tidyChannel ?? true,
        pauseBelowPlayers: patch.pauseBelowPlayers ?? e?.pauseBelowPlayers ?? 0,
        registeredOnlyIngame: patch.registeredOnlyIngame ?? e?.registeredOnlyIngame ?? false,
        registeredOnlyDiscord: patch.registeredOnlyDiscord ?? e?.registeredOnlyDiscord ?? false,
        startupState: patch.startupState ?? e?.startupState ?? "remember",
      };
      const { rows } = await this.pool.query(
        `INSERT INTO mapvote_config (server_id, enabled, surface, channel_id, poll_hours, timezone, profiles, reminders,
                                     live_apply, post_match_apply_delay_seconds, poll_reset_delay_seconds, tidy_channel, pause_below_players,
                                     registered_only_ingame, registered_only_discord, startup_state, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (server_id) DO UPDATE SET
           enabled=EXCLUDED.enabled, surface=EXCLUDED.surface, channel_id=EXCLUDED.channel_id,
           poll_hours=EXCLUDED.poll_hours, timezone=EXCLUDED.timezone, profiles=EXCLUDED.profiles,
           reminders=EXCLUDED.reminders, live_apply=EXCLUDED.live_apply,
           post_match_apply_delay_seconds=EXCLUDED.post_match_apply_delay_seconds,
           poll_reset_delay_seconds=EXCLUDED.poll_reset_delay_seconds,
           tidy_channel=EXCLUDED.tidy_channel,
           pause_below_players=EXCLUDED.pause_below_players,
           registered_only_ingame=EXCLUDED.registered_only_ingame, registered_only_discord=EXCLUDED.registered_only_discord,
           startup_state=EXCLUDED.startup_state, updated_at=now()
         RETURNING *`,
        [serverId, c.enabled, c.surface, c.channelId, c.pollHours, c.timezone, JSON.stringify(c.profiles), JSON.stringify(c.reminders),
         c.liveApply, c.postMatchApplyDelaySeconds, c.pollResetDelaySeconds, c.tidyChannel, c.pauseBelowPlayers, c.registeredOnlyIngame, c.registeredOnlyDiscord, c.startupState],
      );
      return toMapVoteConfig(rows[0], await this.mapVoteLibrary());
    },
    getState: async (serverId: string): Promise<MapVoteStateRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM mapvote_state WHERE server_id = $1", [serverId]);
      return rows[0] ? toMapVoteState(rows[0]) : null;
    },
    setState: async (state: MapVoteStateRow): Promise<void> => {
      await this.pool.query(
        `INSERT INTO mapvote_state (server_id, active_message_id, active_channel_id, options, profile, opened_at, last_match_end_at, paused, override_map_id, recent_maps, tallies, tallied_at, skip_next, reroll,
                                    pause_reason, saved_options, pause_notice_id, start_now, resync_now, send_message_layout, live_applied_map_id, reopen_at, manual_hold_until, ingame_voters, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24::jsonb, now())
         ON CONFLICT (server_id) DO UPDATE SET
           active_message_id=EXCLUDED.active_message_id, active_channel_id=EXCLUDED.active_channel_id,
           options=EXCLUDED.options, profile=EXCLUDED.profile, opened_at=EXCLUDED.opened_at,
           last_match_end_at=EXCLUDED.last_match_end_at, paused=EXCLUDED.paused,
           override_map_id=EXCLUDED.override_map_id, recent_maps=EXCLUDED.recent_maps,
           tallies=EXCLUDED.tallies, tallied_at=EXCLUDED.tallied_at,
           skip_next=EXCLUDED.skip_next, reroll=EXCLUDED.reroll,
           pause_reason=EXCLUDED.pause_reason, saved_options=EXCLUDED.saved_options,
           pause_notice_id=EXCLUDED.pause_notice_id, start_now=EXCLUDED.start_now,
           resync_now=EXCLUDED.resync_now, send_message_layout=EXCLUDED.send_message_layout,
           live_applied_map_id=EXCLUDED.live_applied_map_id, reopen_at=EXCLUDED.reopen_at,
           manual_hold_until=EXCLUDED.manual_hold_until, ingame_voters=EXCLUDED.ingame_voters, updated_at=now()`,
        [state.serverId, state.activeMessageId, state.activeChannelId, JSON.stringify(state.options), state.profile, state.openedAt, state.lastMatchEndAt, state.paused, state.overrideMapId, JSON.stringify(state.recentMaps), JSON.stringify(state.tallies ?? []), state.talliedAt, state.skipNext ?? false, state.reroll ?? false,
         state.pauseReason ?? null, JSON.stringify(state.savedOptions ?? []), state.pauseNoticeId ?? null, state.startNow ?? false, state.resyncNow ?? false, state.sendMessageLayout ?? null, state.liveAppliedMapId ?? null, state.reopenAt ?? null, state.manualHoldUntil ?? null,
         state.ingameVoters ? JSON.stringify(state.ingameVoters) : null],
      );
    },
    patchState: async (serverId: string, patch: MapVoteStatePatch): Promise<MapVoteStateRow> => {
      // Only the columns the caller actually decided are written, so the worker's tick and a staff
      // button press no longer overwrite each other's fields. Every column in this table is
      // nullable or defaulted, so an INSERT naming a subset is well-defined for a first write.
      const cols: string[] = [];
      const vals: unknown[] = [serverId];
      const put = (col: string, value: unknown, cast = "") => {
        vals.push(value);
        cols.push(`${col}=$${vals.length}${cast}`);
      };
      const p = patch as Record<string, unknown>;
      const has = (k: keyof MapVoteStatePatch) => Object.prototype.hasOwnProperty.call(p, k);
      if (has("activeMessageId")) put("active_message_id", patch.activeMessageId ?? null);
      if (has("activeChannelId")) put("active_channel_id", patch.activeChannelId ?? null);
      if (has("options")) put("options", JSON.stringify(patch.options ?? []), "::jsonb");
      if (has("profile")) put("profile", patch.profile ?? null);
      if (has("openedAt")) put("opened_at", patch.openedAt ?? null);
      if (has("lastMatchEndAt")) put("last_match_end_at", patch.lastMatchEndAt ?? null);
      if (has("paused")) put("paused", patch.paused ?? false);
      if (has("pauseReason")) put("pause_reason", patch.pauseReason ?? null);
      if (has("savedOptions")) put("saved_options", JSON.stringify(patch.savedOptions ?? []), "::jsonb");
      if (has("pauseNoticeId")) put("pause_notice_id", patch.pauseNoticeId ?? null);
      if (has("overrideMapId")) put("override_map_id", patch.overrideMapId ?? null);
      if (has("recentMaps")) put("recent_maps", JSON.stringify(patch.recentMaps ?? []), "::jsonb");
      if (has("tallies")) put("tallies", JSON.stringify(patch.tallies ?? []), "::jsonb");
      if (has("talliedAt")) put("tallied_at", patch.talliedAt ?? null);
      if (has("lastClosedMessageId")) put("last_closed_message_id", patch.lastClosedMessageId ?? null);
      if (has("lastClosedChannelId")) put("last_closed_channel_id", patch.lastClosedChannelId ?? null);
      if (has("skipNext")) put("skip_next", patch.skipNext ?? false);
      if (has("reroll")) put("reroll", patch.reroll ?? false);
      if (has("startNow")) put("start_now", patch.startNow ?? false);
      if (has("resyncNow")) put("resync_now", patch.resyncNow ?? false);
      if (has("sendMessageLayout")) put("send_message_layout", patch.sendMessageLayout ?? null);
      if (has("liveAppliedMapId")) put("live_applied_map_id", patch.liveAppliedMapId ?? null);
      if (has("liveApplyNote")) put("live_apply_note", patch.liveApplyNote ?? null);
      if (has("ingameVoters")) put("ingame_voters", patch.ingameVoters ? JSON.stringify(patch.ingameVoters) : null, "::jsonb");
      if (has("reopenAt")) put("reopen_at", patch.reopenAt ?? null);
      if (has("manualHoldUntil")) put("manual_hold_until", patch.manualHoldUntil ?? null);
      if (has("lastOpenError")) put("last_open_error", patch.lastOpenError ?? null);

      // An empty patch still has to return the row (and create it if this server has none yet).
      const setSql = [...cols, "updated_at=now()"].join(", ");
      const insertCols = ["server_id", ...cols.map((c) => c.slice(0, c.indexOf("=")))];
      const insertVals = ["$1", ...cols.map((c) => c.slice(c.indexOf("=") + 1))];
      const { rows } = await this.pool.query(
        `INSERT INTO mapvote_state (${insertCols.join(", ")})
         VALUES (${insertVals.join(", ")})
         ON CONFLICT (server_id) DO UPDATE SET ${setSql}
         RETURNING *`,
        vals,
      );
      return toMapVoteState(rows[0]);
    },
    recordHistory: async (input: NewMapVoteHistory): Promise<MapVoteHistoryRow> => {
      const id = randomUUID();
      const { rows } = await this.pool.query(
        `INSERT INTO mapvote_history (id, server_id, decided_at, profile, options, winner_id, winner_name, total_votes, outcome, applied)
         VALUES ($1,$2,COALESCE($3, now()),$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING *`,
        [id, input.serverId, input.decidedAt ?? null, input.profile, JSON.stringify(input.options ?? []), input.winnerId, input.winnerName, input.totalVotes ?? 0, input.outcome, input.applied ?? false],
      );
      const row = toMapVoteHistory(rows[0]);
      // Flatten the ballot for querying. One statement rather than a row per voter, so a busy poll
      // costs one round trip; ON CONFLICT makes a re-record of the same poll harmless.
      const ballots: { mapId: string; mapName: string; discordId: string; name: string; won: boolean }[] = [];
      for (const o of input.options ?? []) {
        for (const v of o.voters ?? []) {
          if (!v?.discordId) continue;
          ballots.push({ mapId: o.id, mapName: o.name ?? o.id, discordId: v.discordId, name: v.name ?? "", won: o.id === input.winnerId });
        }
      }
      if (ballots.length > 0) {
        await this.pool.query(
          `INSERT INTO mapvote_ballots (id, history_id, server_id, decided_at, map_id, map_name, discord_user_id, discord_name, won)
           SELECT gen_random_uuid(), $1, $2, $3, b.map_id, b.map_name, b.discord_user_id, b.discord_name, b.won
             FROM jsonb_to_recordset($4::jsonb)
                  AS b(map_id text, map_name text, discord_user_id text, discord_name text, won boolean)
           ON CONFLICT (history_id, map_id, discord_user_id) DO NOTHING`,
          [row.id, input.serverId, row.decidedAt,
           JSON.stringify(ballots.map((b) => ({ map_id: b.mapId, map_name: b.mapName, discord_user_id: b.discordId, discord_name: b.name, won: b.won })))],
        );
      }
      return row;
    },
    history: async (serverId: string, limit = 50, offset = 0): Promise<MapVoteHistoryRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM mapvote_history WHERE server_id = $1 ORDER BY decided_at DESC LIMIT $2 OFFSET $3",
        [serverId, Math.max(1, Math.min(500, limit)), Math.max(0, offset)],
      );
      return rows.map(toMapVoteHistory);
    },
    historyCount: async (serverId: string): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM mapvote_history WHERE server_id = $1", [serverId]);
      return rows[0]?.n ?? 0;
    },
    historySummary: async (serverId: string) => {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS rounds,
                count(*) FILTER (WHERE outcome = 'vote')::int AS decided,
                count(*) FILTER (WHERE outcome = 'override')::int AS forced,
                count(*) FILTER (WHERE outcome = 'no_votes')::int AS silent,
                COALESCE(sum(total_votes), 0)::int AS total_votes,
                count(*) FILTER (WHERE total_votes > 0)::int AS contested
         FROM mapvote_history WHERE server_id = $1`,
        [serverId],
      );
      const r = rows[0] ?? {};
      return { rounds: r.rounds ?? 0, decided: r.decided ?? 0, forced: r.forced ?? 0, silent: r.silent ?? 0, totalVotes: r.total_votes ?? 0, contested: r.contested ?? 0 };
    },
    mapTally: async (serverId: string, limit = 200): Promise<MapVoteTally[]> => {
      // One row per option ever offered: how often it appeared, how often it won, votes attracted.
      const { rows } = await this.pool.query(
        `SELECT o->>'id' AS map_id,
                max(o->>'name') AS name,
                count(*)::int AS offered,
                count(*) FILTER (WHERE h.winner_id = o->>'id')::int AS won,
                COALESCE(sum((o->>'votes')::int), 0)::int AS votes
           FROM mapvote_history h
           CROSS JOIN LATERAL jsonb_array_elements(h.options) o
          WHERE h.server_id = $1
          GROUP BY o->>'id'
          ORDER BY won DESC, offered DESC
          LIMIT $2`,
        [serverId, Math.max(1, Math.min(1000, limit))],
      );
      return rows.map((r: any) => ({ mapId: r.map_id, name: r.name ?? r.map_id, offered: r.offered, won: r.won, votes: r.votes }));
    },
    voterSummary: async (serverId: string, limit = 100): Promise<MapVoteVoterSummary[]> => {
      // Names come from the most recent ballot, so someone who renames on Discord is still shown
      // as the person staff know today. The LEFT JOINs turn an identity into a person: the external
      // link says which game player a snowflake is, users says whether it's a staff account.
      //
      // An IN-GAME voter is not a snowflake at all — the chat surface counts them under
      // "player:<key>", where the key is their player id when the log gave one. That id is right
      // there in the identity, so `pg` resolves it directly; without this join the panel told staff
      // that a player it knows by name is "not linked to a game account", and pointed them at a
      // Discord link that was never the problem. A name-keyed ballot (the parser missed the id)
      // compares as plain text against p.id::text and simply finds nothing, which is correct.
      const { rows } = await this.pool.query(
        `SELECT b.discord_user_id,
                (array_agg(b.discord_name ORDER BY b.decided_at DESC))[1]     AS discord_name,
                count(*)::int                                                 AS votes,
                count(*) FILTER (WHERE b.won)::int                            AS wins,
                max(b.decided_at)                                             AS last_voted_at,
                max(u.id::text)                                               AS user_id,
                coalesce(max(p.id::text), max(pg.id::text))                   AS player_id,
                coalesce(max(p.name), max(pg.name))                           AS player_name
           FROM mapvote_ballots b
           LEFT JOIN users u ON u.discord_id = b.discord_user_id
           LEFT JOIN external_links el ON el.provider = 'discord' AND el.external_id = b.discord_user_id
           LEFT JOIN players p ON p.id = el.player_id
           LEFT JOIN players pg ON b.discord_user_id LIKE 'player:%'
                               AND pg.id::text = substring(b.discord_user_id from 8)
          WHERE b.server_id = $1
          GROUP BY b.discord_user_id
          ORDER BY votes DESC, last_voted_at DESC
          LIMIT $2`,
        [serverId, Math.max(1, Math.min(500, limit))],
      );
      return rows.map((r: any) => ({
        discordUserId: r.discord_user_id,
        // Never the raw identity as a fallback name: for an in-game voter that is "player:<uuid>",
        // which is an internal id printed where staff expect a person.
        discordName: r.discord_name || (String(r.discord_user_id).startsWith("player:") ? "(unnamed player)" : r.discord_user_id),
        votes: r.votes, wins: r.wins, lastVotedAt: new Date(r.last_voted_at).toISOString(),
        userId: r.user_id ?? null, playerId: r.player_id ?? null, playerName: r.player_name ?? null,
        ingame: String(r.discord_user_id).startsWith("player:"),
      }));
    },
    preferences: async (discordUserId: string, opts: { serverId?: string; serverIds?: string[]; limit?: number } = {}): Promise<MapVotePreference[]> => {
      const { rows } = await this.pool.query(
        `SELECT map_id,
                (array_agg(map_name ORDER BY decided_at DESC))[1] AS name,
                count(*)::int                      AS votes,
                count(*) FILTER (WHERE won)::int   AS wins,
                max(decided_at)                    AS last_voted_at
           FROM mapvote_ballots
          WHERE discord_user_id = $1 AND ($2::uuid IS NULL OR server_id = $2) AND ($4::uuid[] IS NULL OR server_id = ANY($4))
          GROUP BY map_id
          ORDER BY votes DESC, last_voted_at DESC
          LIMIT $3`,
        [discordUserId, opts.serverId ?? null, Math.max(1, Math.min(500, opts.limit ?? 50)), opts.serverIds ?? null],
      );
      return rows.map((r: any) => ({
        mapId: r.map_id, name: r.name || r.map_id, votes: r.votes, wins: r.wins,
        lastVotedAt: new Date(r.last_voted_at).toISOString(),
      }));
    },
    ballots: async (discordUserId: string, opts: { serverId?: string; serverIds?: string[]; limit?: number } = {}): Promise<MapVoteBallotRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM mapvote_ballots
          WHERE discord_user_id = $1 AND ($2::uuid IS NULL OR server_id = $2) AND ($4::uuid[] IS NULL OR server_id = ANY($4))
          ORDER BY decided_at DESC LIMIT $3`,
        [discordUserId, opts.serverId ?? null, Math.max(1, Math.min(500, opts.limit ?? 100)), opts.serverIds ?? null],
      );
      return rows.map(toMapVoteBallot);
    },
    voterTotals: async (discordUserId: string, serverId?: string, serverIds?: string[]) => {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS votes, count(*) FILTER (WHERE won)::int AS wins,
                min(decided_at) AS first_voted_at, max(decided_at) AS last_voted_at
           FROM mapvote_ballots
          WHERE discord_user_id = $1 AND ($2::uuid IS NULL OR server_id = $2) AND ($3::uuid[] IS NULL OR server_id = ANY($3))`,
        [discordUserId, serverId ?? null, serverIds ?? null],
      );
      const r = rows[0] ?? {};
      return {
        votes: Number(r.votes ?? 0), wins: Number(r.wins ?? 0),
        firstVotedAt: r.first_voted_at ? new Date(r.first_voted_at).toISOString() : null,
        lastVotedAt: r.last_voted_at ? new Date(r.last_voted_at).toISOString() : null,
      };
    },
  };

  playerBans = {
    list: async (query: { game?: string; playerId?: string; activeOnly?: boolean } = {}): Promise<PlayerBanRow[]> => {
      const filters: string[] = [];
      const args: unknown[] = [];
      if (query.game) { args.push(query.game); filters.push(`game = $${args.length}`); }
      if (query.playerId) { args.push(query.playerId); filters.push(`player_id = $${args.length}`); }
      if (query.activeOnly) filters.push("lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const { rows } = await this.pool.query(`SELECT * FROM player_ban ${where} ORDER BY created_at DESC, id DESC`, args);
      return rows.map(toPlayerBan);
    },
    get: async (id: string): Promise<PlayerBanRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM player_ban WHERE id = $1", [id]);
      return rows[0] ? toPlayerBan(rows[0]) : null;
    },
    create: async (input: NewPlayerBan): Promise<PlayerBanRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO player_ban (id, game, player_id, player_name, kind, reason, category, scope, expires_at, created_by_user_id, created_by_name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,COALESCE($12::timestamptz, now())) RETURNING *`,
        [randomUUID(), input.game, input.playerId, input.playerName ?? null, input.kind, input.reason,
          input.category ?? null, JSON.stringify(input.scope), input.expiresAt ?? null,
          input.createdByUserId ?? null, input.createdByName, input.createdAt ?? null],
      );
      return toPlayerBan(rows[0]);
    },
    // `lifted_at IS NULL` in the WHERE, not just the SET: the first lift is the fact, and a second
    // one must not overwrite who did it or when.
    lift: async (id: string, liftedByName: string, liftedAt?: string): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        `UPDATE player_ban SET lifted_at = COALESCE($3::timestamptz, now()), lifted_by_name = $2
         WHERE id = $1 AND lifted_at IS NULL`,
        [id, liftedByName, liftedAt ?? null],
      );
      return (rowCount ?? 0) > 0;
    },
    liftAllFor: async (playerId: string, liftedByName: string, kind?: "temp" | "perma"): Promise<number> => {
      const args: unknown[] = [playerId, liftedByName];
      let extra = "";
      if (kind) { args.push(kind); extra = ` AND kind = $${args.length}`; }
      const { rowCount } = await this.pool.query(
        `UPDATE player_ban SET lifted_at = now(), lifted_by_name = $2 WHERE player_id = $1 AND lifted_at IS NULL${extra}`,
        args,
      );
      return rowCount ?? 0;
    },
    setScope: async (id: string, scope: BanScopeJson): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        "UPDATE player_ban SET scope = $2::jsonb WHERE id = $1 AND lifted_at IS NULL",
        [id, JSON.stringify(scope)],
      );
      return (rowCount ?? 0) > 0;
    },
    setExpiry: async (id: string, expiresAt: string | null): Promise<boolean> => {
      const { rowCount } = await this.pool.query(
        "UPDATE player_ban SET expires_at = $2 WHERE id = $1 AND lifted_at IS NULL", [id, expiresAt],
      );
      return (rowCount ?? 0) > 0;
    },
  };

  economy = {
    member: async (discordId: string): Promise<CommunityMemberRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM community_members WHERE discord_id = $1", [discordId]);
      return rows[0] ? toMember(rows[0]) : null;
    },
    ensureMember: async (discordId: string, discordName?: string | null): Promise<CommunityMemberRow> => {
      // COALESCE keeps the stored name when the caller has nothing fresher to offer.
      const { rows } = await this.pool.query(
        `INSERT INTO community_members (discord_id, discord_name) VALUES ($1, $2)
         ON CONFLICT (discord_id) DO UPDATE SET
           discord_name = COALESCE(EXCLUDED.discord_name, community_members.discord_name),
           updated_at = CASE WHEN EXCLUDED.discord_name IS NOT NULL
             AND EXCLUDED.discord_name IS DISTINCT FROM community_members.discord_name
             THEN now() ELSE community_members.updated_at END
         RETURNING *`,
        [discordId, discordName ?? null],
      );
      return toMember(rows[0]);
    },
    members: async (query: { q?: string; limit?: number; offset?: number } = {}): Promise<CommunityMemberRow[]> => {
      const q = (query.q ?? "").trim();
      const { rows } = await this.pool.query(
        `SELECT * FROM community_members
         WHERE ($1 = '' OR discord_id ILIKE $4 OR discord_name ILIKE $4)
         ORDER BY balance DESC, discord_id ASC LIMIT $2 OFFSET $3`,
        [q, query.limit ?? 100, query.offset ?? 0, containsLike(q)],
      );
      return rows.map(toMember);
    },
    membersCount: async (q?: string): Promise<number> => {
      const needle = (q ?? "").trim();
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM community_members
         WHERE ($1 = '' OR discord_id ILIKE $2 OR discord_name ILIKE $2)`,
        [needle, containsLike(needle)],
      );
      return rows[0].n as number;
    },
    overCap: async (cap: number | null): Promise<{ members: number; excess: number }> => {
      if (cap === null) return { members: 0, excess: 0 };
      const { rows } = await this.pool.query(
        "SELECT count(*)::int AS n, COALESCE(sum(balance - $1), 0)::int AS excess FROM community_members WHERE balance > $1",
        [cap],
      );
      return { members: rows[0].n as number, excess: rows[0].excess as number };
    },
    trimToCap: async (cap: number, actorName: string, reason = "balance cap trim"): Promise<{ members: number; removed: number }> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Lock the over-cap rows first so a concurrent claim cannot slip in between the ledger
        // write and the balance write and leave the two disagreeing.
        const { rows: over } = await client.query(
          "SELECT discord_id, balance FROM community_members WHERE balance > $1 ORDER BY discord_id FOR UPDATE",
          [cap],
        );
        if (over.length === 0) { await client.query("COMMIT"); return { members: 0, removed: 0 }; }
        // No `ref`: this is not a replayable event keyed to something, it is a correction, and the
        // idempotence comes from the WHERE — run it twice and the second finds nobody over.
        await client.query(
          `INSERT INTO economy_ledger (discord_id, delta, reason, ref, actor_name)
           SELECT discord_id, $1 - balance, $2, NULL, $3
             FROM community_members WHERE balance > $1`,
          [cap, reason, actorName],
        );
        const { rows: after } = await client.query(
          "UPDATE community_members SET balance = $1, updated_at = now() WHERE balance > $1 RETURNING discord_id",
          [cap],
        );
        await client.query("COMMIT");
        const removed = over.reduce((n, r) => n + ((r.balance as number) - cap), 0);
        return { members: after.length, removed };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    apply: async (entry: NewEconomyEntry, opts: { maxBalance?: number | null } = {}): Promise<{ member: CommunityMemberRow; entry: EconomyLedgerRow; applied: boolean }> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Upsert-then-lock: the row is guaranteed to exist, and FOR UPDATE makes the
        // read-clamp-write below race-free against a concurrent claim or purchase.
        await client.query(
          `INSERT INTO community_members (discord_id, discord_name) VALUES ($1, $2)
           ON CONFLICT (discord_id) DO UPDATE SET
             discord_name = COALESCE(EXCLUDED.discord_name, community_members.discord_name)`,
          [entry.discordId, entry.discordName ?? null],
        );
        const { rows: mRows } = await client.query("SELECT * FROM community_members WHERE discord_id = $1 FOR UPDATE", [entry.discordId]);
        const before = toMember(mRows[0]);
        if (entry.ref) {
          const { rows: existing } = await client.query("SELECT * FROM economy_ledger WHERE ref = $1", [entry.ref]);
          if (existing[0]) {
            // The ref already owns its event — this call is a replay, and replays change nothing.
            await client.query("ROLLBACK");
            return { member: before, entry: toLedger(existing[0]), applied: false };
          }
        }
        let delta = Math.trunc(entry.delta);
        const cap = opts.maxBalance ?? null;
        // Credits TRIM at the cap (the row records the applied delta, possibly zero); debits
        // below zero refuse here AND at the CHECK constraint, whichever is reached first.
        if (delta > 0 && cap !== null) delta = Math.min(delta, Math.max(0, cap - before.balance));
        if (before.balance + delta < 0) throw new InsufficientBalance(before.balance, -delta);
        const { rows: eRows } = await client.query(
          `INSERT INTO economy_ledger (discord_id, delta, reason, ref, actor_name)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [entry.discordId, delta, entry.reason, entry.ref ?? null, entry.actorName ?? null],
        );
        const { rows: after } = await client.query(
          "UPDATE community_members SET balance = balance + $2, updated_at = now() WHERE discord_id = $1 RETURNING *",
          [entry.discordId, delta],
        );
        await client.query("COMMIT");
        return { member: toMember(after[0]), entry: toLedger(eRows[0]), applied: true };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    activity: async (opts: { kind?: string; limit?: number; offset?: number } = {}): Promise<{ entries: EconomyActivityRow[]; total: number }> => {
      // The WHERE is built from the shared kinds table, never from caller strings — an unknown
      // kind returns nothing (a typo must not read as "all"), and "adjust" is the null-ref match.
      let where = "TRUE";
      const args: unknown[] = [];
      if (opts.kind !== undefined) {
        const def = ECONOMY_ACTIVITY_KINDS[opts.kind];
        if (!def) return { entries: [], total: 0 };
        if (def.prefixes === null) where = "l.ref IS NULL";
        else {
          args.push(def.prefixes.map((p) => p.replace(/[\\%_]/g, "\\$&") + "%"));
          where = `l.ref LIKE ANY($${args.length})`;
        }
      }
      const limit = opts.limit ?? ECONOMY_LEDGER_PAGE;
      const offset = opts.offset ?? 0;
      const { rows } = await this.pool.query(
        `SELECT l.*, m.discord_name FROM economy_ledger l
           LEFT JOIN community_members m ON m.discord_id = l.discord_id
          WHERE ${where}
          ORDER BY l.created_at DESC, l.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset],
      );
      const { rows: count } = await this.pool.query(`SELECT count(*)::int AS n FROM economy_ledger l WHERE ${where}`, args);
      return {
        entries: rows.map((r: any) => ({ ...toLedger(r), discordName: r.discord_name ?? null, kind: economyActivityKind(r.ref ?? null) })),
        total: count[0].n as number,
      };
    },
    ledger: async (discordId: string, opts: { limit?: number; offset?: number } = {}): Promise<EconomyLedgerRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM economy_ledger WHERE discord_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3",
        [discordId, opts.limit ?? ECONOMY_LEDGER_PAGE, opts.offset ?? 0],
      );
      return rows.map(toLedger);
    },
    ledgerCount: async (discordId: string): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM economy_ledger WHERE discord_id = $1", [discordId]);
      return rows[0].n as number;
    },
    lastEntryWithRefPrefix: async (discordId: string, prefix: string): Promise<EconomyLedgerRow | null> => {
      // LIKE with the wildcard appended in SQL; the prefix itself is a parameter, never spliced.
      const { rows } = await this.pool.query(
        `SELECT * FROM economy_ledger WHERE discord_id = $1 AND ref LIKE $2 || '%'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [discordId, prefix],
      );
      return rows[0] ? toLedger(rows[0]) : null;
    },
    config: async (): Promise<EconomyConfig> => {
      const { rows } = await this.pool.query("SELECT config, updated_at FROM economy_config WHERE id = true");
      const stored = (rows[0]?.config ?? {}) as Partial<EconomyConfig>;
      // Defaults fill anything the stored document predates, so adding a setting never
      // needs a migration — the same shape every jsonb config in this project uses.
      return {
        ...ECONOMY_DEFAULTS,
        ...stored,
        // Per-band, not just per-section: a document written before roleIds existed carries a
        // whole `daily` object, and a shallow merge would hand it back without the new field.
        claims: {
          daily: { ...ECONOMY_DEFAULTS.claims.daily, ...(stored.claims?.daily ?? {}) },
          monthly: { ...ECONOMY_DEFAULTS.claims.monthly, ...(stored.claims?.monthly ?? {}) },
        },
        gifting: { ...ECONOMY_DEFAULTS.gifting, ...(stored.gifting ?? {}) },
        vipGifting: { ...ECONOMY_DEFAULTS.vipGifting, ...(stored.vipGifting ?? {}) },
        registration: { ...ECONOMY_DEFAULTS.registration, ...(stored.registration ?? {}) },
        // An offer saved before role gating existed carries no roleIds; it reads back ungated.
        offers: (stored.offers ?? []).map((o) => ({ ...o, roleIds: o.roleIds ?? [] })),
        updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at as string).toISOString() : new Date(0).toISOString(),
      };
    },
    setConfig: async (patch: EconomyConfigPatch): Promise<EconomyConfig> => {
      const current = await this.economy.config();
      const { updatedAt: _drop, ...rest } = current;
      const next = { ...rest, ...patch };
      await this.pool.query(
        `INSERT INTO economy_config (id, config, updated_at) VALUES (true, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [JSON.stringify(next)],
      );
      return this.economy.config();
    },
  };

  appConfig = {
    get: async (): Promise<AppConfig> => {
      const { rows } = await this.pool.query("SELECT config, updated_at FROM app_config WHERE id = true");
      const stored = (rows[0]?.config ?? {}) as Partial<AppConfig>;
      return {
        ...APP_CONFIG_DEFAULTS,
        ...stored,
        // Guarded on the way OUT as well as in: a zone that was valid when saved can stop being
        // one after a tzdata change, and every reader would then throw.
        timezone: safeTimezone(stored.timezone, APP_CONFIG_DEFAULTS.timezone),
        communityGuildId: String(stored.communityGuildId ?? APP_CONFIG_DEFAULTS.communityGuildId),
        approvalsChannelId: String(stored.approvalsChannelId ?? ""),
        approvalsMentionRoleId: String(stored.approvalsMentionRoleId ?? ""),
        requestCeilingRoleId: String(stored.requestCeilingRoleId ?? ""),
        requestDraftTtlHours: Number.isFinite(Number(stored.requestDraftTtlHours)) ? Number(stored.requestDraftTtlHours) : APP_CONFIG_DEFAULTS.requestDraftTtlHours,
        // A jsonb row written before the field existed has no array — that is "no badges", not
        // a crash in every roster poll.
        roleBadges: Array.isArray(stored.roleBadges) ? stored.roleBadges : [],
        clanTags: normalizeClanTagSettings(stored.clanTags),
        updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at as string).toISOString() : new Date(0).toISOString(),
      };
    },
    set: async (patch: Partial<Omit<AppConfig, "updatedAt">>): Promise<AppConfig> => {
      const current = await this.appConfig.get();
      const { updatedAt: _drop, ...rest } = current;
      const next = { ...rest, ...patch, ...(patch.timezone !== undefined ? { timezone: safeTimezone(patch.timezone, current.timezone) } : {}) };
      await this.pool.query(
        `INSERT INTO app_config (id, config, updated_at) VALUES (true, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [JSON.stringify(next)],
      );
      return this.appConfig.get();
    },
  };

  installSettings = {
    get: async (key: string): Promise<string | null> => {
      const { rows } = await this.pool.query("SELECT value FROM install_settings WHERE key = $1", [key]);
      return rows[0] ? openInstallValue(rows[0].value as string) : null;
    },
    set: async (key: string, value: string | null, opts: { secret?: boolean; by?: string | null } = {}): Promise<void> => {
      if (value === null) {
        await this.pool.query("DELETE FROM install_settings WHERE key = $1", [key]);
        return;
      }
      await this.pool.query(
        `INSERT INTO install_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, sealInstallValue(value, opts.secret), opts.by ?? null],
      );
    },
    getOrCreate: async (key: string, make: () => string, opts: { secret?: boolean } = {}): Promise<string> => {
      const { rows } = await this.pool.query("SELECT value FROM install_settings WHERE key = $1", [key]);
      if (rows[0]) {
        const kept = openInstallValue(rows[0].value as string);
        if (kept !== null) return kept;
        // Sealed under a key this install no longer holds: nothing can read it, so it is replaced.
        const fresh = make();
        await this.pool.query("UPDATE install_settings SET value = $2, updated_at = now() WHERE key = $1", [key, sealInstallValue(fresh, opts.secret)]);
        return fresh;
      }
      const fresh = make();
      await this.pool.query("INSERT INTO install_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, sealInstallValue(fresh, opts.secret)]);
      return (await this.installSettings.get(key)) ?? fresh;
    },
  };

  brandImages = {
    get: async (key: BrandImageKey): Promise<BrandImageRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM brand_images WHERE key = $1", [key]);
      return rows[0] ? toBrandImage(rows[0]) : null;
    },
    set: async (key: BrandImageKey, image: { mime: string; bytes: Uint8Array; by: string | null }): Promise<BrandImageRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO brand_images (key, mime, bytes, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [key, image.mime, Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength), image.by],
      );
      return toBrandImage(rows[0]);
    },
    remove: async (key: BrandImageKey): Promise<boolean> => ((await this.pool.query("DELETE FROM brand_images WHERE key = $1", [key])).rowCount ?? 0) > 0,
  };

  chatFilter = {
    get: async (): Promise<ChatFilterConfig> => {
      const { rows } = await this.pool.query("SELECT config, updated_at FROM chat_filter WHERE id = true");
      const stored = (rows[0]?.config ?? {}) as Partial<ChatFilterConfig>;
      return {
        ...CHAT_FILTER_DEFAULTS,
        ...stored,
        // A jsonb row written by hand or by an older build gets the defensive reading every
        // single-row config here gets: arrays are arrays, maps are maps, never a crash downstream.
        words: Array.isArray(stored.words) ? stored.words.map(String) : [],
        censorApplied: stored.censorApplied && typeof stored.censorApplied === "object" && !Array.isArray(stored.censorApplied)
          ? Object.fromEntries(Object.entries(stored.censorApplied).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]))
          : {},
        updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at as string).toISOString() : new Date(0).toISOString(),
      };
    },
    set: async (patch: Partial<Omit<ChatFilterConfig, "updatedAt">>): Promise<ChatFilterConfig> => {
      const current = await this.chatFilter.get();
      const { updatedAt: _drop, ...rest } = current;
      const next = { ...rest, ...patch };
      await this.pool.query(
        `INSERT INTO chat_filter (id, config, updated_at) VALUES (true, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [JSON.stringify(next)],
      );
      return this.chatFilter.get();
    },
  };

  discordCommands = {
    get: async (): Promise<DiscordCommandConfig> => {
      const { rows } = await this.pool.query("SELECT config, updated_at FROM discord_commands WHERE id = true");
      const stored = (rows[0]?.config ?? {}) as Partial<DiscordCommandConfig>;
      // Defaults underneath, so an install that has never renamed the command reads back as the
      // shipped name rather than as blanks.
      return {
        ...DISCORD_COMMAND_DEFAULTS,
        ...stored,
        updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at as string).toISOString() : new Date(0).toISOString(),
      };
    },
    set: async (patch: Partial<Omit<DiscordCommandConfig, "updatedAt">>): Promise<DiscordCommandConfig> => {
      const current = await this.discordCommands.get();
      const { updatedAt: _drop, ...rest } = current;
      const next = { ...rest, ...patch };
      await this.pool.query(
        `INSERT INTO discord_commands (id, config, updated_at) VALUES (true, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [JSON.stringify(next)],
      );
      return this.discordCommands.get();
    },
  };

  payouts = {
    create: async (input: NewPayoutJob): Promise<PayoutJobRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO payout_jobs (source_type, source_ref, payout_type, amount, server_ids, audience,
                                  dry_run, status, requested_by_user_id, requested_by_name, total_count, duplicate_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.sourceType, JSON.stringify(input.sourceRef ?? {}), input.payoutType, input.amount,
         JSON.stringify(input.serverIds ?? []), input.audience, input.dryRun, input.status,
         input.requestedByUserId ?? null, input.requestedByName ?? "", input.totalCount, input.duplicateKey],
      );
      return toPayoutJob(rows[0]);
    },
    addItem: async (input: NewPayoutItem): Promise<void> => {
      await this.pool.query(
        `INSERT INTO payout_items (job_id, player_id, discord_id, display_name, status, error, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.jobId, input.playerId ?? null, input.discordId ?? null, input.displayName ?? "",
         input.status, input.error ?? "", JSON.stringify(input.detail ?? {})],
      );
    },
    openItems: async (jobId: string, rows: { playerId: string | null; discordId: string | null; displayName: string }[]): Promise<number[]> => {
      if (!rows.length) return [];
      // One statement for the whole list; WITH ORDINALITY keeps the ids in the order given.
      const { rows: out } = await this.pool.query(
        `INSERT INTO payout_items (job_id, player_id, discord_id, display_name, status)
         SELECT $1, r.player_id, r.discord_id, r.display_name, 'PENDING'
           FROM unnest($2::uuid[], $3::text[], $4::text[]) WITH ORDINALITY AS r(player_id, discord_id, display_name, ord)
          ORDER BY r.ord
         RETURNING id`,
        [jobId, rows.map((r) => r.playerId), rows.map((r) => r.discordId), rows.map((r) => r.displayName ?? "")],
      );
      return (out as { id: string }[]).map((r) => Number(r.id)).sort((a, b) => a - b);
    },
    settleItem: async (id: number, outcome: { status: "PASS" | "FAIL"; error: string; detail: Record<string, unknown> }): Promise<void> => {
      await this.pool.query(
        "UPDATE payout_items SET status=$2, error=$3, detail=$4 WHERE id=$1",
        [id, outcome.status, outcome.error ?? "", JSON.stringify(outcome.detail ?? {})],
      );
    },
    finish: async (id: string, patch: { status: PayoutJobRow["status"]; successCount: number; failedCount: number }): Promise<void> => {
      await this.pool.query(
        "UPDATE payout_jobs SET status=$2, success_count=$3, failed_count=$4, completed_at=now() WHERE id=$1",
        [id, patch.status, patch.successCount, patch.failedCount],
      );
    },
    get: async (id: string): Promise<PayoutJobRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM payout_jobs WHERE id = $1", [id]);
      return rows[0] ? toPayoutJob(rows[0]) : null;
    },
    list: async (opts?: { limit?: number; offset?: number }): Promise<PayoutJobRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM payout_jobs ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2",
        [opts?.limit ?? 50, opts?.offset ?? 0],
      );
      return rows.map(toPayoutJob);
    },
    count: async (): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM payout_jobs");
      return Number(rows[0]?.n ?? 0);
    },
    forEvents: async (eventIds: string[]): Promise<PayoutJobRow[]> => {
      if (!eventIds.length) return [];
      // UNION, not UNION ALL: a run already on the chain is not walked twice, so even a loop in
      // the data ends the recursion.
      const { rows } = await this.pool.query(
        `WITH RECURSIVE chain AS (
           SELECT j.* FROM payout_jobs j
            WHERE j.source_type = 'event' AND NOT j.dry_run AND j.source_ref->>'eventId' = ANY($1::text[])
           UNION
           SELECT r.* FROM payout_jobs r JOIN chain c ON r.source_ref->>'jobId' = c.id::text
            WHERE r.source_type = 'retry' AND NOT r.dry_run
         )
         SELECT * FROM chain ORDER BY created_at, id`,
        [eventIds],
      );
      return rows.map(toPayoutJob);
    },
    items: async (jobId: string, opts?: { limit?: number; offset?: number }): Promise<PayoutItemRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM payout_items WHERE job_id = $1 ORDER BY id LIMIT $2 OFFSET $3",
        [jobId, opts?.limit ?? 500, opts?.offset ?? 0],
      );
      return rows.map(toPayoutItem);
    },
    itemsCount: async (jobId: string): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM payout_items WHERE job_id = $1", [jobId]);
      return Number(rows[0]?.n ?? 0);
    },
    failedItems: async (jobId: string, opts?: { includePending?: boolean }): Promise<PayoutItemRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM payout_items WHERE job_id = $1 AND status = ANY($2::text[]) ORDER BY id`,
        [jobId, opts?.includePending ? ["FAIL", "PENDING"] : ["FAIL"]],
      );
      return rows.map(toPayoutItem);
    },
    findDuplicate: async (duplicateKey: string): Promise<PayoutJobRow | null> => {
      // md5() engages the index (keys can outgrow a btree entry); the raw match settles collisions.
      const { rows } = await this.pool.query(
        `SELECT * FROM payout_jobs WHERE md5(duplicate_key) = md5($1) AND duplicate_key = $1
          AND NOT dry_run AND status IN ('RUNNING','COMPLETE','COMPLETE_WITH_FAILURES','INTERRUPTED')
          ORDER BY created_at DESC LIMIT 1`,
        [duplicateKey],
      );
      return rows[0] ? toPayoutJob(rows[0]) : null;
    },
    interruptStale: async (): Promise<number> => {
      const { rows } = await this.pool.query(
        `UPDATE payout_jobs j SET status='INTERRUPTED', completed_at=now(),
                success_count = (SELECT count(*) FROM payout_items i WHERE i.job_id = j.id AND i.status = 'PASS'),
                failed_count  = (SELECT count(*) FROM payout_items i WHERE i.job_id = j.id AND i.status <> 'PASS')
          WHERE status='RUNNING' RETURNING id`,
      );
      return rows.length;
    },
  };

  payoutEvents = {
    create: async (input: NewPayoutEvent): Promise<PayoutEventRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO payout_events (name, server_id, open_mode, open_anchor, close_mode, close_anchor, min_minutes, map_vote_profile, rotation_set_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.name, input.serverId, input.openMode, input.openAnchor, input.closeMode, input.closeAnchor,
         input.minMinutes ?? 0, input.mapVoteProfile ?? null, input.rotationSetId ?? null, input.createdBy ?? ""],
      );
      return toPayoutEvent(rows[0]);
    },
    get: async (id: string): Promise<PayoutEventRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM payout_events WHERE id = $1", [id]);
      return rows[0] ? toPayoutEvent(rows[0]) : null;
    },
    list: async (opts?: { limit?: number; offset?: number }): Promise<PayoutEventRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM payout_events ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2",
        [opts?.limit ?? 50, opts?.offset ?? 0],
      );
      return rows.map(toPayoutEvent);
    },
    count: async (): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM payout_events");
      return Number(rows[0]?.n ?? 0);
    },
    pending: async (): Promise<PayoutEventRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM payout_events WHERE status IN ('scheduled','open') ORDER BY created_at",
      );
      return rows.map(toPayoutEvent);
    },
    applyTransition: async (id: string, t: { openedAt?: string; closedAt?: string; roster?: { playerId: string; name: string | null; minutes: number }[] }): Promise<PayoutEventRow | null> => {
      // Two status-guarded UPDATEs rather than one clever one: the guards are what make a racing
      // worker+API pair safe (whoever loses the race matches zero rows), and a sweep that opens
      // AND closes in one pass is just both updates in order.
      if (t.openedAt) {
        await this.pool.query(
          "UPDATE payout_events SET status='open', opened_at=$2 WHERE id=$1 AND status='scheduled'",
          [id, t.openedAt],
        );
      }
      if (t.closedAt) {
        await this.pool.query(
          `UPDATE payout_events SET status='closed', closed_at=$2, roster=COALESCE($3::jsonb, roster)
           WHERE id=$1 AND status='open'`,
          [id, t.closedAt, t.roster ? JSON.stringify(t.roster) : null],
        );
      }
      const { rows } = await this.pool.query("SELECT * FROM payout_events WHERE id = $1", [id]);
      return rows[0] ? toPayoutEvent(rows[0]) : null;
    },
    update: async (id: string, patch: PayoutEventPatch): Promise<PayoutEventRow | null> => {
      // Two guarded UPDATEs rather than one: what may change depends on the status, and expressing
      // that as WHERE clauses keeps the rule in the database instead of in a read-then-write race.
      // The open boundary and the server move only while the event is still `scheduled` (see
      // PayoutEventPatch); everything else moves while it is scheduled OR open. A closed or
      // cancelled event matches neither, so it comes back untouched and the caller says so.
      const set: string[] = [];
      const args: unknown[] = [id];
      const add = (col: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); };
      if (patch.name !== undefined) add("name", patch.name);
      if (patch.minMinutes !== undefined) add("min_minutes", patch.minMinutes);
      if (patch.mapVoteProfile !== undefined) add("map_vote_profile", patch.mapVoteProfile);
      if (patch.rotationSetId !== undefined) add("rotation_set_id", patch.rotationSetId);
      if (patch.closeMode !== undefined) add("close_mode", patch.closeMode);
      if (patch.closeAnchor !== undefined) add("close_anchor", patch.closeAnchor);
      if (set.length) {
        await this.pool.query(
          `UPDATE payout_events SET ${set.join(", ")} WHERE id = $1 AND status IN ('scheduled','open')`, args);
      }
      const fresh: string[] = [];
      const freshArgs: unknown[] = [id];
      const addFresh = (col: string, v: unknown) => { freshArgs.push(v); fresh.push(`${col} = $${freshArgs.length}`); };
      if (patch.serverId !== undefined) addFresh("server_id", patch.serverId);
      if (patch.openMode !== undefined) addFresh("open_mode", patch.openMode);
      if (patch.openAnchor !== undefined) addFresh("open_anchor", patch.openAnchor);
      if (fresh.length) {
        await this.pool.query(
          `UPDATE payout_events SET ${fresh.join(", ")} WHERE id = $1 AND status = 'scheduled'`, freshArgs);
      }
      const { rows } = await this.pool.query(
        "SELECT * FROM payout_events WHERE id = $1 AND status IN ('scheduled','open')", [id]);
      return rows[0] ? toPayoutEvent(rows[0]) : null;
    },
    markRotationApplied: async (id: string, atIso: string): Promise<void> => {
      await this.pool.query(
        "UPDATE payout_events SET rotation_applied_at = $2 WHERE id = $1 AND rotation_applied_at IS NULL",
        [id, atIso],
      );
    },
    cancel: async (id: string): Promise<boolean> => {
      const { rows } = await this.pool.query(
        "UPDATE payout_events SET status='cancelled' WHERE id=$1 AND status IN ('scheduled','open') RETURNING id",
        [id],
      );
      return rows.length > 0;
    },
    setNoPayout: async (id: string, mark: { at: string; by: string } | null): Promise<PayoutEventRow | null> => {
      const { rows } = await this.pool.query(
        "UPDATE payout_events SET no_payout_at = $2, no_payout_by = $3 WHERE id = $1 AND status = 'closed' RETURNING *",
        [id, mark?.at ?? null, mark?.by ?? null],
      );
      return rows[0] ? toPayoutEvent(rows[0]) : null;
    },
    getPostConfig: async (): Promise<EventPostConfig> => {
      const { rows } = await this.pool.query("SELECT * FROM event_post_config WHERE singleton = true");
      const r = rows[0];
      return r
        ? {
            enabled: r.enabled, channelId: r.channel_id, daysAhead: Number(r.days_ahead),
            weekday: Number(r.weekday), atHour: Number(r.at_hour), atMinute: Number(r.at_minute),
            lastPostedOn: r.last_posted_on ?? null,
          }
        : { ...EVENT_POST_DEFAULTS };
    },
    setPostConfig: async (patch: Partial<EventPostConfig>): Promise<EventPostConfig> => {
      // COALESCE per column, so a patch of one field leaves the rest exactly as they were —
      // the same shape (and the same reason) as the announcement nudge's config writer.
      //
      // `last_posted_on` is the exception, and cannot use it: null is a real VALUE there ("nothing
      // has gone out for this schedule — post again today"), not "leave this alone". Under COALESCE
      // the two are the same request, so moving today's 9:30 post to 10:00 would silently keep the
      // latch and skip the day the person was watching for. The flag says which of the two was
      // meant; the memory store gets this for free by spreading the patch.
      const clearsLatch = "lastPostedOn" in patch;
      const { rows } = await this.pool.query(
        `INSERT INTO event_post_config (singleton, enabled, channel_id, days_ahead, weekday, at_hour, at_minute, last_posted_on)
         VALUES (true, COALESCE($1, false), COALESCE($2, ''), COALESCE($3, 14), COALESCE($4, 1), COALESCE($5, 9), COALESCE($6, 0), $7)
         ON CONFLICT (singleton) DO UPDATE SET
           enabled = COALESCE($1, event_post_config.enabled),
           channel_id = COALESCE($2, event_post_config.channel_id),
           days_ahead = COALESCE($3, event_post_config.days_ahead),
           weekday = COALESCE($4, event_post_config.weekday),
           at_hour = COALESCE($5, event_post_config.at_hour),
           at_minute = COALESCE($6, event_post_config.at_minute),
           last_posted_on = CASE WHEN $8::boolean THEN $7 ELSE event_post_config.last_posted_on END,
           updated_at = now()
         RETURNING *`,
        [patch.enabled ?? null, patch.channelId ?? null, patch.daysAhead ?? null, patch.weekday ?? null,
         patch.atHour ?? null, patch.atMinute ?? null, patch.lastPostedOn ?? null, clearsLatch],
      );
      const r = rows[0];
      return {
        enabled: r.enabled, channelId: r.channel_id, daysAhead: Number(r.days_ahead),
        weekday: Number(r.weekday), atHour: Number(r.at_hour), atMinute: Number(r.at_minute),
        lastPostedOn: r.last_posted_on ?? null,
      };
    },
  };

  crconBans = {
    list: async (query: { serverId?: string } = {}): Promise<CrconBanRow[]> => {
      const args: unknown[] = [];
      const where = query.serverId ? (args.push(query.serverId), "WHERE server_id = $1") : "";
      const { rows } = await this.pool.query(`SELECT * FROM crcon_ban ${where} ORDER BY created_at DESC, id DESC`, args);
      return rows.map(toCrconBan);
    },
    upsert: async (input: NewCrconBan): Promise<CrconBanRow> => {
      // created_at is the ban's OWN moment when the record carries one, and LEAST on conflict so
      // a re-apply lowers rows an older import stamped with the import clock — never raises.
      const { rows } = await this.pool.query(
        `INSERT INTO crcon_ban (server_id, player_id, player_name, type, reason, expires_at, author, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))
         ON CONFLICT (server_id, player_id, type) DO UPDATE SET
           player_name = EXCLUDED.player_name, reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at, author = EXCLUDED.author,
           created_at = LEAST(crcon_ban.created_at, EXCLUDED.created_at)
         RETURNING *`,
        [input.serverId, input.playerId, input.playerName ?? null, input.type, input.reason ?? null, input.expiresAt ?? null, input.author ?? null, input.bannedAt ?? null],
      );
      return toCrconBan(rows[0]);
    },
    remove: async (serverId: string, playerId: string, type: "temp" | "perma"): Promise<boolean> => {
      const { rowCount } = await this.pool.query("DELETE FROM crcon_ban WHERE server_id = $1 AND player_id = $2 AND type = $3", [serverId, playerId, type]);
      return (rowCount ?? 0) > 0;
    },
  };

  matches = {
    open: async (input: { serverId: string; map: string | null; startedAt: string }): Promise<MatchRow> => {
      // Close-then-insert must be atomic PER SERVER: two writers interleaving (a runner restart
      // briefly overlapping its replacement, an import running beside live ingest) can both pass
      // the close step and then collide on matches_one_open_idx — the partial "one open match"
      // index that ON CONFLICT (server_id, started_at) cannot arbitrate. The advisory lock
      // serializes openers of the same server and costs nothing across servers.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('match_open'), hashtext($1))", [input.serverId]);
        // Close any still-open match on this server (a new round supersedes an unfinished one).
        await client.query("UPDATE matches SET ended_at = $2 WHERE server_id = $1 AND ended_at IS NULL", [input.serverId, input.startedAt]);
        const { rows } = await client.query(
          // `game` is stamped from the server AS THE ROUND OPENS — which is exactly what "the
          // game it was played on" means, and taking it in SQL means no caller can forget it.
          `INSERT INTO matches (id, server_id, game, map, started_at)
           VALUES ($1,$2,(SELECT game FROM servers WHERE id = $2),$3,$4)
           ON CONFLICT (server_id, started_at) DO UPDATE SET map = EXCLUDED.map, ended_at = NULL RETURNING *`,
          [randomUUID(), input.serverId, input.map, input.startedAt],
        );
        await client.query("COMMIT");
        return toMatch(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    getOpen: async (serverId: string): Promise<MatchRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM matches WHERE server_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", [serverId]);
      return rows[0] ? toMatch(rows[0]) : null;
    },
    recordTimeline: async (matchId: string, step: { flip?: [number, number, number]; morale?: [number, number, number]; matchTime?: number; initialMorale?: number }): Promise<void> => {
      if (!step.flip && !step.morale && step.matchTime === undefined && step.initialMorale === undefined) return;
      // jsonb_build_array wraps the point so || appends it as ONE element, not its three numbers.
      await this.pool.query(
        `UPDATE matches SET
           cap_flips = CASE WHEN $2::jsonb IS NULL THEN cap_flips ELSE cap_flips || jsonb_build_array($2::jsonb) END,
           morale_history = CASE WHEN $3::jsonb IS NULL THEN morale_history ELSE morale_history || jsonb_build_array($3::jsonb) END,
           match_time = CASE WHEN match_time = 0 AND $4::int IS NOT NULL THEN $4::int ELSE match_time END,
           crcon_initial_morale = COALESCE(crcon_initial_morale, $5::int)
         WHERE id = $1`,
        [matchId, step.flip ? JSON.stringify(step.flip) : null, step.morale ? JSON.stringify(step.morale) : null,
          step.matchTime ?? null, step.initialMorale ?? null],
      );
    },
    recordStart: async (matchId: string, start: { map: string; guessed: boolean; matchTime: number; initialMorale: number | null }): Promise<void> => {
      await this.pool.query(
        `UPDATE matches SET
           crcon_map = $2, crcon_guessed = $3,
           match_time = CASE WHEN match_time = 0 THEN $4::int ELSE match_time END,
           crcon_initial_morale = COALESCE(crcon_initial_morale, $5::int)
         WHERE id = $1 AND crcon_map IS NULL`,
        [matchId, start.map, start.guessed, start.matchTime, start.initialMorale],
      );
    },
    recordEnd: async (matchId: string, end: { deferred: boolean }): Promise<void> => {
      await this.pool.query("UPDATE matches SET crcon_end_deferred = $2 WHERE id = $1 AND crcon_end_deferred IS NULL", [matchId, end.deferred]);
    },
    crconPlayers: async (matchId: string): Promise<CrconPlayerCache | null> => {
      const { rows } = await this.pool.query("SELECT players FROM crcon_player_stats WHERE match_id = $1", [matchId]);
      return rows[0] ? (rows[0].players as CrconPlayerCache) : null;
    },
    crconShortRoundPlayers: async (seq: number): Promise<CrconPlayerCache | null> => {
      if (!Number.isSafeInteger(seq)) return null;
      const { rows } = await this.pool.query("SELECT player_stats FROM crcon_short_rounds WHERE seq = $1", [seq]);
      return (rows[0]?.player_stats as CrconPlayerCache | null | undefined) ?? null;
    },
    saveCrconPlayers: async (matchId: string, cache: CrconPlayerCache): Promise<void> => {
      // An array of pairs, so the players keep the order CRCON's dict has them in. A round deleted
      // between the recorder's read and this write simply has nothing to attach to.
      await this.pool.query(
        `INSERT INTO crcon_player_stats (match_id, players, updated_at)
         SELECT $1, $2::jsonb, now() WHERE EXISTS (SELECT 1 FROM matches WHERE id = $1)
         ON CONFLICT (match_id) DO UPDATE SET players = EXCLUDED.players, updated_at = now()`,
        [matchId, JSON.stringify(cache)],
      );
    },
    appendScoreSeries: async (matchId: string, points: ScoreSeriesPoint[]): Promise<void> => {
      // One point per player per call: a platform id listed twice would make the upsert touch the
      // same row twice in one statement, which Postgres refuses.
      const byPlatform = new Map<string, ScoreSeriesPoint>();
      for (const pt of points) byPlatform.set(pt.platformId, pt);
      if (!byPlatform.size) return;
      // The series is stored packed (score-series-pack.ts), each number as its change since the
      // point before, so a point cannot be tacked on in SQL: each player's series is read, the
      // point added, and the series written back whole, the one row write a moving score always
      // cost. Writers of one round take turns (the lock lasts as long as the transaction), or two
      // could each write back a series that lacks the other's point.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('score_series'), hashtext($1))", [matchId]);
        const { rows } = await client.query(
          `SELECT p.platform_id, p.id AS player_id, s.points, s.packed
             FROM players p
             LEFT JOIN match_score_series s ON s.match_id = $1::uuid AND s.player_id = p.id
            WHERE p.platform_id = ANY($2::text[]) AND EXISTS (SELECT 1 FROM matches WHERE id = $1::uuid)`,
          [matchId, [...byPlatform.keys()]],
        );
        const ids: string[] = [];
        const packed: Buffer[] = [];
        for (const r of rows as { platform_id: string; player_id: string; points: number[] | null; packed: Buffer | null }[]) {
          const pt = byPlatform.get(r.platform_id)!;
          const point = [pt.sec, pt.combat, pt.offense, pt.defense, pt.support].map((n) => Math.max(0, Math.round(n)));
          // A row written before the packing keeps its plain points until this rewrite moves it over.
          const series = r.packed ? unpackScoreSeries(r.packed) : (r.points ?? []).map(Number);
          // A point that repeats the player's last totals adds nothing to a chart, so it is dropped:
          // a quiet minute costs no row write, and neither does a pass replayed after a restart.
          if (series.length >= 5 && series.slice(-4).every((v, i) => v === point[i + 1])) continue;
          const bytes = packScoreSeries([...series, ...point]);
          ids.push(r.player_id);
          packed.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
        if (ids.length) {
          await client.query(
            `INSERT INTO match_score_series (match_id, player_id, points, packed)
             SELECT $1::uuid, v.player_id, '{}', v.packed FROM unnest($2::uuid[], $3::bytea[]) AS v(player_id, packed)
              WHERE EXISTS (SELECT 1 FROM matches WHERE id = $1::uuid)
             ON CONFLICT (match_id, player_id) DO UPDATE SET points = '{}', packed = EXCLUDED.packed`,
            [matchId, ids, packed],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    scoreSeries: async (matchId: string): Promise<Map<string, number[]>> => {
      const { rows } = await this.pool.query("SELECT player_id, points, packed FROM match_score_series WHERE match_id = $1", [matchId]);
      const out = new Map<string, number[]>();
      for (const r of rows as { player_id: string; points: number[]; packed: Buffer | null }[]) {
        // Packed wherever it is set; a round finished before the packing keeps its plain points.
        const flat = r.packed ? unpackScoreSeries(r.packed) : r.points.map(Number);
        if (flat.length) out.set(r.player_id, flat);
      }
      return out;
    },
    recordScore: async (serverId: string, score: { alliedScore: number; axisScore: number; initialMorale?: number; alliedMorale?: number; axisMorale?: number }): Promise<void> => {
      // COALESCE for the morale half: a later score-only sample (the common case — every
      // non-conquest tick) must not erase morale a conquest tick already recorded.
      await this.pool.query(
        `UPDATE matches SET allied_score = $2, axis_score = $3,
           initial_morale = COALESCE($4, initial_morale),
           allied_morale = COALESCE($5, allied_morale),
           axis_morale = COALESCE($6, axis_morale)
         WHERE server_id = $1 AND ended_at IS NULL`,
        [serverId, score.alliedScore, score.axisScore, score.initialMorale ?? null, score.alliedMorale ?? null, score.axisMorale ?? null],
      );
    },
    close: async (id: string, patch: { endedAt: string; winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; result: string | null }): Promise<MatchRow | null> => {
      // COALESCE, not assignment: the sampled score is real evidence and a scoreless MATCH ENDED
      // line must not wipe it. The winner is then derived from whatever score survives, so a round
      // the log did not call still credits the side that actually won it.
      const { rows } = await this.pool.query(
        `UPDATE matches SET ended_at = $2,
           allied_score = COALESCE($4, allied_score),
           axis_score = COALESCE($5, axis_score),
           winner = COALESCE($3, CASE
             WHEN COALESCE($4, allied_score) IS NULL OR COALESCE($5, axis_score) IS NULL THEN NULL
             WHEN COALESCE($4, allied_score) > COALESCE($5, axis_score) THEN 'allies'
             WHEN COALESCE($4, allied_score) < COALESCE($5, axis_score) THEN 'axis'
             ELSE NULL END),
           result = $6
         WHERE id = $1 RETURNING *`,
        [id, patch.endedAt, patch.winner, patch.alliedScore, patch.axisScore, patch.result],
      );
      return rows[0] ? toMatch(rows[0]) : null;
    },
    discardShort: async (id: string, endedAt: string, endedText?: string | null): Promise<boolean> => {
      // Locked, so a settle or a sample landing at the same moment waits for the verdict. The
      // length is measured here, against the stored start: no caller can delete a real game.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT started_at, settled_at IS NOT NULL AS settled, scores_credited FROM matches WHERE id = $1 FOR UPDATE", [id],
        );
        const row = rows[0];
        if (!row || !(Date.parse(endedAt) - new Date(row.started_at).getTime() < MIN_MATCH_MS)) {
          await client.query("COMMIT");
          return false;
        }
        // Take back what it gave careers: the scores the sampler credited (it credited exactly what
        // the lines hold — each sample added only the rise over them) and a settled played/won.
        if (row.settled || row.scores_credited) {
          await client.query(
            `UPDATE player_stats ps SET
               matches_played = GREATEST(ps.matches_played - CASE WHEN $2::boolean THEN 1 ELSE 0 END, 0),
               matches_won = GREATEST(ps.matches_won - CASE WHEN $2::boolean AND m.won THEN 1 ELSE 0 END, 0),
               combat = GREATEST(ps.combat - CASE WHEN $3::boolean THEN m.combat ELSE 0 END, 0),
               offense = GREATEST(ps.offense - CASE WHEN $3::boolean THEN m.offense ELSE 0 END, 0),
               defense = GREATEST(ps.defense - CASE WHEN $3::boolean THEN m.defense ELSE 0 END, 0),
               support = GREATEST(ps.support - CASE WHEN $3::boolean THEN m.support ELSE 0 END, 0),
               vehicle_kills = GREATEST(ps.vehicle_kills - CASE WHEN $3::boolean THEN m.vehicle_kills ELSE 0 END, 0),
               vehicles_destroyed = GREATEST(ps.vehicles_destroyed - CASE WHEN $3::boolean THEN m.vehicles_destroyed ELSE 0 END, 0),
               updated_at = now()
             FROM player_match_stats m
             WHERE m.match_id = $1 AND ps.player_id = m.player_id AND ps.server_id = m.server_id`,
            [id, row.settled, row.scores_credited],
          );
        }
        // What CRCON lists of it outlives our record (crcon_short_rounds).
        await client.query(
          `INSERT INTO crcon_short_rounds (seq, server_id, game, map, crcon_map, crcon_guessed, crcon_initial_morale,
             crcon_end_deferred, started_at, ended_at, cap_flips, morale_history, match_time, sector_layout,
             allied_score, axis_score, result, created_at, player_stats)
           SELECT seq, server_id, game, map, crcon_map, crcon_guessed, crcon_initial_morale,
             crcon_end_deferred, started_at, COALESCE(ended_at, $2::timestamptz), cap_flips, morale_history, match_time, sector_layout,
             allied_score, axis_score, COALESCE(result, $3), created_at,
             (SELECT players FROM crcon_player_stats WHERE match_id = $1)
           FROM matches WHERE id = $1
           ON CONFLICT (seq) DO NOTHING`,
          [id, endedAt, endedText ?? null],
        );
        await client.query("DELETE FROM matches WHERE id = $1", [id]); // its lines and rollups cascade
        await client.query("COMMIT");
        return true;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    get: async (id: string): Promise<MatchRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM matches WHERE id = $1", [id]);
      return rows[0] ? toMatch(rows[0]) : null;
    },
    crconRounds: async (serverId: string, limit: number, offset: number): Promise<CrconRoundRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT * FROM (${CRCON_ROUNDS_SQL}) r ORDER BY started_at DESC, seq DESC LIMIT $2 OFFSET $3`,
        [serverId, Math.max(limit, 0), Math.max(offset, 0)],
      );
      return rows.map(toCrconRound);
    },
    crconRoundCount: async (serverId: string): Promise<number> => {
      const { rows } = await this.pool.query(
        `SELECT (SELECT count(*) FROM matches WHERE server_id = $1) + (SELECT count(*) FROM crcon_short_rounds WHERE server_id = $1) AS n`,
        [serverId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    crconRoundBySeq: async (serverId: string, seq: number): Promise<{ round: CrconRoundRow; newer: CrconRoundRow | null } | null> => {
      if (!Number.isSafeInteger(seq)) return null; // a public query string must not reach the driver unchecked
      const { rows } = await this.pool.query(`SELECT * FROM (${CRCON_ROUNDS_SQL}) r WHERE seq = $2`, [serverId, seq]);
      if (!rows[0]) return null;
      const round = toCrconRound(rows[0]);
      const next = await this.pool.query(
        `SELECT * FROM (${CRCON_ROUNDS_SQL}) r WHERE (started_at, seq) > ($2::timestamptz, $3::bigint) ORDER BY started_at, seq LIMIT 1`,
        [serverId, round.startedAt, round.seq],
      );
      return { round, newer: next.rows[0] ? toCrconRound(next.rows[0]) : null };
    },
    getBySeq: async (seq: number): Promise<MatchRow | null> => {
      if (!Number.isSafeInteger(seq)) return null; // NaN/1e999 from a public query string must not reach the driver
      const { rows } = await this.pool.query("SELECT * FROM matches WHERE seq = $1", [seq]);
      return rows[0] ? toMatch(rows[0]) : null;
    },
    list: async (serverId: string, limit = 100, offset = 0, beforeIso?: string): Promise<MatchRow[]> => {
      // started_at can tie across servers restarting together; id gives the total order paging needs.
      if (beforeIso) {
        const { rows } = await this.pool.query(
          "SELECT * FROM matches WHERE server_id = $1 AND started_at < $4 ORDER BY started_at DESC, id DESC LIMIT $2 OFFSET $3",
          [serverId, limit, Math.max(offset, 0), beforeIso],
        );
        return rows.map(toMatch);
      }
      const { rows } = await this.pool.query(
        "SELECT * FROM matches WHERE server_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2 OFFSET $3",
        [serverId, limit, Math.max(offset, 0)],
      );
      return rows.map(toMatch);
    },
    count: async (serverId: string): Promise<number> => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM matches WHERE server_id = $1", [serverId]);
      return rows[0]?.n ?? 0;
    },
    firstStartedAfter: async (serverId: string, iso: string): Promise<MatchRow | null> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM matches WHERE server_id = $1 AND started_at >= $2 ORDER BY started_at LIMIT 1",
        [serverId, iso],
      );
      return rows[0] ? toMatch(rows[0]) : null;
    },
    firstEndedAfter: async (serverId: string, iso: string): Promise<MatchRow | null> => {
      // Ordered by ended_at, not started_at: the round that closes an event is the first to
      // FINISH past the anchor, which is not always the first to have started.
      const { rows } = await this.pool.query(
        "SELECT * FROM matches WHERE server_id = $1 AND ended_at >= $2 ORDER BY ended_at LIMIT 1",
        [serverId, iso],
      );
      return rows[0] ? toMatch(rows[0]) : null;
    },
    bumpStat: async (input: { matchId: string; playerId: string; serverId: string; playerName?: string | null; side?: "allies" | "axis" | null; kills?: number; deaths?: number; teamkills?: number }): Promise<void> => {
      await this.pool.query(
        `INSERT INTO player_match_stats (match_id, player_id, server_id, player_name, side, kills, deaths, teamkills, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (match_id, player_id) DO UPDATE SET
           kills = player_match_stats.kills + EXCLUDED.kills,
           deaths = player_match_stats.deaths + EXCLUDED.deaths,
           teamkills = player_match_stats.teamkills + EXCLUDED.teamkills,
           player_name = COALESCE(EXCLUDED.player_name, player_match_stats.player_name),
           side = COALESCE(EXCLUDED.side, player_match_stats.side),
           updated_at = now()`,
        [input.matchId, input.playerId, input.serverId, input.playerName ?? null, input.side ?? null, input.kills ?? 0, input.deaths ?? 0, input.teamkills ?? 0],
      );
    },
    bumpStatMany: async (inputs: { matchId: string; playerId: string; serverId: string; playerName?: string | null; side?: "allies" | "axis" | null; kills?: number; deaths?: number; teamkills?: number }[]): Promise<void> => {
      // Merge by (match, player) first — one row cannot be the conflict target twice in a single
      // statement. Counts add; name and side keep the LAST non-null, which is what the per-call
      // COALESCE did when these arrived one at a time.
      type Acc = { serverId: string; playerName: string | null; side: "allies" | "axis" | null; kills: number; deaths: number; teamkills: number };
      const merged = new Map<string, Acc>();
      for (const i of inputs) {
        if (!i.matchId || !i.playerId) continue;
        const key = `${i.matchId}\u0000${i.playerId}`;
        const cur = merged.get(key) ?? { serverId: i.serverId, playerName: null, side: null, kills: 0, deaths: 0, teamkills: 0 };
        cur.kills += i.kills ?? 0;
        cur.deaths += i.deaths ?? 0;
        cur.teamkills += i.teamkills ?? 0;
        if (i.playerName != null) cur.playerName = i.playerName;
        if (i.side != null) cur.side = i.side;
        merged.set(key, cur);
      }
      if (merged.size === 0) return;
      const vals: unknown[] = [];
      // Sorted for consistent lock order across concurrent flushes (deadlock prevention).
      const tuples = [...merged].sort(([a], [b]) => a < b ? -1 : 1).map(([key, a], n) => {
        const [matchId, playerId] = key.split("\u0000");
        vals.push(matchId, playerId, a.serverId, a.playerName, a.side, a.kills, a.deaths, a.teamkills);
        const b = n * 8;
        return `($${b + 1}::uuid,$${b + 2}::uuid,$${b + 3}::uuid,$${b + 4}::text,$${b + 5}::text,$${b + 6}::int,$${b + 7}::int,$${b + 8}::int)`;
      });
      await this.pool.query(
        `INSERT INTO player_match_stats (match_id, player_id, server_id, player_name, side, kills, deaths, teamkills, updated_at)
         SELECT match_id, player_id, server_id, player_name, side, kills, deaths, teamkills, now()
         FROM (VALUES ${tuples.join(",")}) AS v(match_id, player_id, server_id, player_name, side, kills, deaths, teamkills)
         ON CONFLICT (match_id, player_id) DO UPDATE SET
           kills = player_match_stats.kills + EXCLUDED.kills,
           deaths = player_match_stats.deaths + EXCLUDED.deaths,
           teamkills = player_match_stats.teamkills + EXCLUDED.teamkills,
           player_name = COALESCE(EXCLUDED.player_name, player_match_stats.player_name),
           side = COALESCE(EXCLUDED.side, player_match_stats.side),
           updated_at = now()`,
        vals,
      );
    },
    statsForMatch: async (matchId: string): Promise<PlayerMatchStatRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM player_match_stats WHERE match_id = $1 ORDER BY kills DESC", [matchId]);
      return rows.map(toMatchStat);
    },
    topStats: async (serverId: string, key: MatchRecordKey, limit = 10): Promise<MatchStatRecord[]> => {
      // The key indexes a fixed map rather than being spliced in — it arrives from a query
      // string, and a whitelist the compiler checks beats trusting the caller sanitized it.
      const col = { kills: "kills", combat: "combat", offense: "offense", defense: "defense", support: "support" }[key];
      const { rows } = await this.pool.query(
        `SELECT s.player_id, s.player_name, s.side, s.${col} AS value, m.seq, m.map, m.started_at
         FROM player_match_stats s JOIN matches m ON m.id = s.match_id
         WHERE s.server_id = $1 AND m.ended_at IS NOT NULL AND s.${col} > 0
         ORDER BY s.${col} DESC, m.started_at DESC LIMIT $2`,
        [serverId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({
        playerId: r.player_id, playerName: r.player_name ?? null, side: r.side ?? null,
        value: Number(r.value) || 0, matchSeq: Number(r.seq), map: r.map ?? null,
        startedAt: new Date(r.started_at).toISOString(),
      }));
    },
    participantCounts: async (serverId: string): Promise<{ matchId: string; players: number }[]> => {
      const { rows } = await this.pool.query(
        "SELECT match_id, COUNT(*)::int AS players FROM player_match_stats WHERE server_id = $1 GROUP BY match_id",
        [serverId],
      );
      return rows.map((r: any) => ({ matchId: r.match_id, players: Number(r.players) || 0 }));
    },
    pendingWeaponRollup: async (limit = 25): Promise<MatchRow[]> => {
      const { rows } = await this.pool.query(
        "SELECT * FROM matches WHERE ended_at IS NOT NULL AND class_rollup_at IS NULL ORDER BY started_at DESC LIMIT $1",
        [Math.min(Math.max(1, limit), 200)],
      );
      return rows.map(toMatch);
    },
    saveWeaponRollup: async (matchId: string, rowsIn: { playerId: string; weapon: string; classId: string; kills: number; deaths: number }[]): Promise<void> => {
      const m = await this.matches.get(matchId);
      if (!m) return;
      // Delete-then-insert, stamp LAST: a re-run after a partial failure redoes the round rather
      // than leaving it half-written and marked done.
      await this.pool.query("DELETE FROM player_match_weapon_kills WHERE match_id = $1", [matchId]);
      const rows = rowsIn.filter((r) => (r.kills > 0 || r.deaths > 0) && r.weapon);
      if (rows.length > 0) {
        const params: unknown[] = [];
        const values = rows.map((r, i) => {
          params.push(matchId, r.playerId, m.serverId, r.weapon, r.classId, r.kills, r.deaths);
          const b = i * 7;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
        });
        await this.pool.query(
          `INSERT INTO player_match_weapon_kills (match_id, player_id, server_id, weapon, class_id, kills, deaths) VALUES ${values.join(", ")}`,
          params,
        );
      }
      await this.pool.query("UPDATE matches SET class_rollup_at = now() WHERE id = $1", [matchId]);
    },
    classesWithData: async (serverId: string): Promise<string[]> => {
      const { rows } = await this.pool.query("SELECT DISTINCT class_id FROM player_match_weapon_kills WHERE server_id = $1", [serverId]);
      return rows.map((r: any) => String(r.class_id));
    },
    topClassKills: async (serverId: string, classId: string, limit = 10): Promise<ClassKillRecord[]> => {
      // A class record is the SUM over that class's weapons for one player in one round, and it
      // names the weapon that carried it — the biggest single-weapon count inside the sum.
      const { rows } = await this.pool.query(
        `SELECT t.player_id, p.name AS player_name, s.side, t.value, t.top_weapon, m.seq, m.map, m.started_at
         FROM (
           SELECT k.match_id, k.player_id, SUM(k.kills)::int AS value,
                  (array_agg(k.weapon ORDER BY k.kills DESC, k.weapon))[1] AS top_weapon
           FROM player_match_weapon_kills k
           WHERE k.server_id = $1 AND k.class_id = $2 AND k.kills > 0
           GROUP BY k.match_id, k.player_id
         ) t
         JOIN matches m ON m.id = t.match_id
         LEFT JOIN players p ON p.id = t.player_id
         LEFT JOIN player_match_stats s ON s.match_id = t.match_id AND s.player_id = t.player_id
         WHERE m.ended_at IS NOT NULL
         ORDER BY t.value DESC, m.started_at DESC LIMIT $3`,
        [serverId, classId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({
        playerId: r.player_id, playerName: r.player_name ?? null, side: r.side ?? null,
        value: Number(r.value) || 0, weapon: r.top_weapon ?? null, matchSeq: Number(r.seq), map: r.map ?? null,
        startedAt: new Date(r.started_at).toISOString(),
      }));
    },
    classTotals: async (serverId: string, classId: string, limit = 10): Promise<{ playerId: string; name: string | null; kills: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT k.player_id, p.name, SUM(k.kills)::int AS kills
         FROM player_match_weapon_kills k LEFT JOIN players p ON p.id = k.player_id
         WHERE k.server_id = $1 AND k.class_id = $2 AND k.kills > 0
         GROUP BY k.player_id, p.name ORDER BY SUM(k.kills) DESC LIMIT $3`,
        [serverId, classId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ playerId: r.player_id, name: r.name ?? null, kills: Number(r.kills) || 0 }));
    },
    weaponSummary: async (serverId: string, limit = 15): Promise<{ weapon: string; classId: string; totalKills: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT weapon, MIN(class_id) AS class_id, SUM(kills)::int AS total
         FROM player_match_weapon_kills WHERE server_id = $1
         GROUP BY weapon HAVING SUM(kills) > 0 ORDER BY SUM(kills) DESC, weapon LIMIT $2`,
        [serverId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ weapon: String(r.weapon), classId: String(r.class_id), totalKills: Number(r.total) || 0 }));
    },
    topWeaponKills: async (serverId: string, weapon: string, limit = 10): Promise<MatchStatRecord[]> => {
      const { rows } = await this.pool.query(
        `SELECT k.player_id, p.name AS player_name, s.side, k.kills AS value, m.seq, m.map, m.started_at
         FROM player_match_weapon_kills k
         JOIN matches m ON m.id = k.match_id
         LEFT JOIN players p ON p.id = k.player_id
         LEFT JOIN player_match_stats s ON s.match_id = k.match_id AND s.player_id = k.player_id
         WHERE k.server_id = $1 AND k.weapon = $2 AND k.kills > 0 AND m.ended_at IS NOT NULL
         ORDER BY k.kills DESC, m.started_at DESC LIMIT $3`,
        [serverId, weapon, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({
        playerId: r.player_id, playerName: r.player_name ?? null, side: r.side ?? null,
        value: Number(r.value) || 0, matchSeq: Number(r.seq), map: r.map ?? null,
        startedAt: new Date(r.started_at).toISOString(),
      }));
    },
    weaponTotals: async (serverId: string, weapon: string, limit = 10): Promise<{ playerId: string; name: string | null; kills: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT k.player_id, p.name, SUM(k.kills)::int AS kills
         FROM player_match_weapon_kills k LEFT JOIN players p ON p.id = k.player_id
         WHERE k.server_id = $1 AND k.weapon = $2 AND k.kills > 0
         GROUP BY k.player_id, p.name ORDER BY SUM(k.kills) DESC LIMIT $3`,
        [serverId, weapon, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ playerId: r.player_id, name: r.name ?? null, kills: Number(r.kills) || 0 }));
    },
    playerWeaponTotals: async (serverId: string, playerId: string, limit = 10): Promise<{ weapon: string; kills: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT weapon, SUM(kills)::int AS kills FROM player_match_weapon_kills
         WHERE server_id = $1 AND player_id = $2 AND kills > 0
         GROUP BY weapon ORDER BY SUM(kills) DESC, weapon LIMIT $3`,
        [serverId, playerId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ weapon: String(r.weapon), kills: Number(r.kills) || 0 }));
    },
    classDeathTotals: async (serverId: string, classId: string, limit = 10): Promise<{ playerId: string; name: string | null; deaths: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT k.player_id, p.name, SUM(k.deaths)::int AS deaths
         FROM player_match_weapon_kills k LEFT JOIN players p ON p.id = k.player_id
         WHERE k.server_id = $1 AND k.class_id = $2 AND k.deaths > 0
         GROUP BY k.player_id, p.name ORDER BY SUM(k.deaths) DESC LIMIT $3`,
        [serverId, classId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ playerId: r.player_id, name: r.name ?? null, deaths: Number(r.deaths) || 0 }));
    },
    weaponDeathTotals: async (serverId: string, weapon: string, limit = 10): Promise<{ playerId: string; name: string | null; deaths: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT k.player_id, p.name, SUM(k.deaths)::int AS deaths
         FROM player_match_weapon_kills k LEFT JOIN players p ON p.id = k.player_id
         WHERE k.server_id = $1 AND k.weapon = $2 AND k.deaths > 0
         GROUP BY k.player_id, p.name ORDER BY SUM(k.deaths) DESC LIMIT $3`,
        [serverId, weapon, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ playerId: r.player_id, name: r.name ?? null, deaths: Number(r.deaths) || 0 }));
    },
    playerWeaponDeathTotals: async (serverId: string, playerId: string, limit = 10): Promise<{ weapon: string; deaths: number }[]> => {
      const { rows } = await this.pool.query(
        `SELECT weapon, SUM(deaths)::int AS deaths FROM player_match_weapon_kills
         WHERE server_id = $1 AND player_id = $2 AND deaths > 0
         GROUP BY weapon ORDER BY SUM(deaths) DESC, weapon LIMIT $3`,
        [serverId, playerId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r: any) => ({ weapon: String(r.weapon), deaths: Number(r.deaths) || 0 }));
    },
    listForPlayer: async (playerId: string, limit = 50): Promise<PlayerMatchRow[]> => {
      const { rows } = await this.pool.query(
        `SELECT s.*, m.map, m.started_at, m.ended_at, m.winner, m.seq
         FROM player_match_stats s JOIN matches m ON m.id = s.match_id
         WHERE s.player_id = $1 ORDER BY m.started_at DESC LIMIT $2`,
        [playerId, limit],
      );
      return rows.map((r: any) => ({
        ...toMatchStat(r), map: r.map ?? null, startedAt: new Date(r.started_at).toISOString(),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null, winner: r.winner ?? null,
        seq: Number(r.seq),
      }));
    },
    aggregateForPlayer: async (playerId: string): Promise<PlayerMatchAggregate> => {
      const { rows } = await this.pool.query(
        `SELECT
           count(*) FILTER (WHERE m.ended_at IS NOT NULL)::int AS matches,
           count(*) FILTER (WHERE m.ended_at IS NOT NULL AND m.winner IS NOT NULL AND s.side = m.winner)::int AS wins,
           count(*) FILTER (WHERE m.ended_at IS NOT NULL AND m.winner IS NOT NULL AND s.side IS NOT NULL AND s.side <> m.winner)::int AS losses,
           COALESCE(sum(s.kills) FILTER (WHERE m.ended_at IS NOT NULL),0)::int AS kills,
           COALESCE(sum(s.deaths) FILTER (WHERE m.ended_at IS NOT NULL),0)::int AS deaths,
           COALESCE(sum(s.teamkills) FILTER (WHERE m.ended_at IS NOT NULL),0)::int AS teamkills
         FROM player_match_stats s JOIN matches m ON m.id = s.match_id
         WHERE s.player_id = $1`,
        [playerId],
      );
      const r = rows[0] ?? {};
      return { matches: r.matches ?? 0, wins: r.wins ?? 0, losses: r.losses ?? 0, kills: r.kills ?? 0, deaths: r.deaths ?? 0, teamkills: r.teamkills ?? 0 };
    },
    participants: async (matchIds: string[]): Promise<PlayerMatchStatRow[]> => {
      if (!matchIds.length) return [];
      const { rows } = await this.pool.query("SELECT * FROM player_match_stats WHERE match_id = ANY($1)", [matchIds]);
      return rows.map(toMatchStat);
    },
    importOne: async (input: { serverId: string; map: string | null; startedAt: string; endedAt: string | null; winner: "allies" | "axis" | null; result: string | null }): Promise<boolean> => {
      // Targetless DO NOTHING rides EVERY unique arbiter: the (server_id, started_at) constraint
      // for re-imports, and matches_one_open_idx for an imported row with no end time while live
      // ingest already holds a real open match — that collision raised a duplicate-key error in
      // production and aborted the import batch. Either way the import row loses, which is right:
      // what is already recorded wins over a backfill.
      const { rowCount } = await this.pool.query(
        `INSERT INTO matches (server_id, game, map, started_at, ended_at, winner, result)
         VALUES ($1,(SELECT game FROM servers WHERE id = $1),$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [input.serverId, input.map, input.startedAt, input.endedAt, input.winner, input.result],
      );
      return (rowCount ?? 0) > 0;
    },
    importScoreboard: async (input: Parameters<Repository["matches"]["importScoreboard"]>[0]): Promise<{ created: boolean; statsApplied: number }> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Same insert as importOne — the scoreboard row is self-sufficient even when the map
        // history stage never ran. Winner derives from the score; what exists already wins.
        const winner = input.alliedScore !== null && input.axisScore !== null && input.alliedScore !== input.axisScore
          ? (input.alliedScore > input.axisScore ? "allies" : "axis") : null;
        const ins = await client.query(
          `INSERT INTO matches (server_id, game, map, started_at, ended_at, winner, allied_score, axis_score)
           VALUES ($1,(SELECT game FROM servers WHERE id = $1),$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING RETURNING id`,
          [input.serverId, input.map, input.startedAt, input.endedAt, winner, input.alliedScore, input.axisScore],
        );
        const created = (ins.rowCount ?? 0) > 0;
        const { rows: found } = created ? { rows: ins.rows } : await client.query(
          "SELECT id FROM matches WHERE server_id = $1 AND started_at = $2", [input.serverId, input.startedAt],
        );
        // No row even after the insert: the one-open-round arbiter refused it (an end-less import
        // colliding with a live open match). That round belongs to the live tracker — leave it.
        if (!found[0]) { await client.query("COMMIT"); return { created: false, statsApplied: 0 }; }
        const matchId = found[0].id as string;
        if (!created) {
          await client.query(
            `UPDATE matches SET
               allied_score = COALESCE(allied_score, $2), axis_score = COALESCE(axis_score, $3),
               winner = COALESCE(winner, $4), ended_at = COALESCE(ended_at, $5)
             WHERE id = $1`,
            [matchId, input.alliedScore, input.axisScore, winner, input.endedAt],
          );
        }
        let statsApplied = 0;
        for (const p of input.stats) {
          // GREATEST everywhere a total is a total; side and playtime fill only blanks. One row
          // per statement keeps this dumb and obviously idempotent — an import runs once a
          // migration, not once a minute, so the sampler's batched cleverness buys nothing here.
          const r = await client.query(
            `INSERT INTO player_match_stats (match_id, player_id, server_id, player_name, side,
                                             kills, deaths, teamkills, combat, offense, defense, support,
                                             vehicle_kills, vehicles_destroyed, role_seconds, sl_seconds, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,0,now())
             ON CONFLICT (match_id, player_id) DO UPDATE SET
               player_name = COALESCE(player_match_stats.player_name, EXCLUDED.player_name),
               side = COALESCE(player_match_stats.side, EXCLUDED.side),
               kills = GREATEST(player_match_stats.kills, EXCLUDED.kills),
               deaths = GREATEST(player_match_stats.deaths, EXCLUDED.deaths),
               teamkills = GREATEST(player_match_stats.teamkills, EXCLUDED.teamkills),
               combat = GREATEST(player_match_stats.combat, EXCLUDED.combat),
               offense = GREATEST(player_match_stats.offense, EXCLUDED.offense),
               defense = GREATEST(player_match_stats.defense, EXCLUDED.defense),
               support = GREATEST(player_match_stats.support, EXCLUDED.support),
               vehicle_kills = GREATEST(player_match_stats.vehicle_kills, EXCLUDED.vehicle_kills),
               vehicles_destroyed = GREATEST(player_match_stats.vehicles_destroyed, EXCLUDED.vehicles_destroyed),
               role_seconds = CASE WHEN player_match_stats.role_seconds = '{}'::jsonb
                                   THEN EXCLUDED.role_seconds ELSE player_match_stats.role_seconds END,
               updated_at = now()`,
            [matchId, p.playerId, input.serverId, p.playerName, p.side,
             p.kills, p.deaths, p.teamkills, p.combat, p.offense, p.defense, p.support,
             p.vehicleKills, p.vehiclesDestroyed,
             // Real role clocks (from CRCON's unit history) when the archive carried them; the
             // "-1 unknown role" sentinel only as the fallback shape.
             JSON.stringify(p.roleSeconds && Object.keys(p.roleSeconds).length > 0
               ? p.roleSeconds
               : p.timeSeconds && p.timeSeconds > 0 ? { "-1": Math.round(p.timeSeconds) } : {})],
          );
          statsApplied += r.rowCount ?? 0;
        }
        await client.query("COMMIT");
        return { created, statsApplied };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    recordSectorLayout: async (input: { serverId: string; layout: string[]; by: string | null }): Promise<MatchRow | null> => {
      // Targets the open round only. Setting a layout while no round is open is legal in game but
      // has no match to belong to, and guessing at the most recent finished one would attribute it
      // to a round that was already over.
      const { rows } = await this.pool.query(
        `UPDATE matches SET sector_layout = $2::jsonb, sector_layout_by = $3, sector_layout_at = now()
         WHERE server_id = $1 AND ended_at IS NULL RETURNING *`,
        [input.serverId, JSON.stringify(input.layout), input.by],
      );
      return rows[0] ? toMatch(rows[0]) : null;
    },
  };

  crconSnapshot = {
    createJob: async (input: NewCrconImportJob): Promise<CrconImportJobRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO crcon_import_job (id, server_id, base_url, api_key, created_by_user_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [randomUUID(), input.serverId, input.baseUrl, input.apiKey, input.createdByUserId ?? null, input.createdByName],
      );
      return toCrconJob(rows[0]);
    },
    getJob: async (id: string): Promise<CrconImportJobRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM crcon_import_job WHERE id = $1", [id]);
      return rows[0] ? toCrconJob(rows[0]) : null;
    },
    getJobApiKey: async (id: string): Promise<string | null> => {
      const { rows } = await this.pool.query("SELECT api_key FROM crcon_import_job WHERE id = $1", [id]);
      return rows[0] ? String(rows[0].api_key ?? "") : null;
    },
    importIntegrity: async (serverId: string) => {
      // Same cutoff definition as the transform uses (events.firstLocalTs): the first event the
      // panel itself witnessed. Everything imported is older by construction.
      const cutoff = await this.events.firstLocalTs(serverId);
      const [imported, cross, matches, sessions] = await Promise.all([
        this.pool.query("SELECT count(*)::int AS n FROM evt WHERE server_id = $1 AND dedupe_key LIKE 'crcon:%'", [serverId]),
        // The same CRCON log row applied under more than one server: only an unfiltered pull on a
        // multi-server install produces this. Counted from THIS server's perspective.
        this.pool.query(
          // crcon:ra:% is excluded on purpose: profile received_actions carry NO server in CRCON,
          // so every server that imports the profile legitimately holds the same key. The
          // fingerprint is for the shared LOG store — rows that DO name a server and were applied
          // to the wrong one.
          `SELECT count(*)::int AS n FROM evt e WHERE e.server_id = $1 AND e.dedupe_key LIKE 'crcon:%'
             AND e.dedupe_key NOT LIKE 'crcon:ra:%'
             AND EXISTS (SELECT 1 FROM evt o WHERE o.dedupe_key = e.dedupe_key AND o.server_id <> e.server_id)`,
          [serverId],
        ),
        cutoff
          ? this.pool.query("SELECT count(*)::int AS n FROM matches WHERE server_id = $1 AND started_at < $2", [serverId, cutoff])
          : this.pool.query("SELECT count(*)::int AS n FROM matches WHERE server_id = $1", [serverId]),
        cutoff
          ? this.pool.query("SELECT count(*)::int AS n FROM player_sessions WHERE server_id = $1 AND connected_at < $2", [serverId, cutoff])
          : this.pool.query("SELECT count(*)::int AS n FROM player_sessions WHERE server_id = $1", [serverId]),
      ]);
      return {
        cutoff,
        importedEvents: imported.rows[0].n as number,
        crossServerEvents: cross.rows[0].n as number,
        preCutoffMatches: matches.rows[0].n as number,
        preCutoffSessions: sessions.rows[0].n as number,
      };
    },
    vipsMovedByImport: async (serverId: string) => {
      // Which VIP expiries no longer agree with the grant that set them.
      //
      // Before `vips.importOne` existed, an apply wrote every archive VIP through `upsert`, whose
      // ON CONFLICT overwrote `expiration` outright — extending, shortening or (on a NULL) making
      // permanent whatever the panel held. The import records no `vip.grant` audit row, so the
      // damage is invisible on the profile; the audit trail is nevertheless what makes it
      // RECOVERABLE, because every real grant wrote `data->>'expiration'` at the time it was made.
      //
      // A row is reported when its newest grant disagrees with what the row now says AND the row
      // was written after that grant — i.e. something other than a staff grant moved it last.
      // `IS DISTINCT FROM` rather than <> so a NULL on either side counts as a difference: the
      // timed-turned-permanent case is the one most worth catching.
      //
      // A group perk's release dates a grant as deliberately as a grant does, so it counts as one;
      // a grant a perk holds is permanent by design and is never reported (nor the time banked
      // while held, which never touched the row).
      //
      // A VIP with no surviving `vip.grant` row cannot be judged and is deliberately NOT reported:
      // it is either a pure import creation (legitimate — importOne would have made it too) or its
      // grant has aged out of a trimmed audit trail, and guessing on either would be worse than
      // saying nothing.
      const { rows } = await this.pool.query<{
        player_id: string; player_name: string | null; current: string | null;
        granted: string | null; granted_at: string; updated_at: string; granted_by: string;
      }>(
        `WITH ${VIP_LAST_SET_CTE}
         SELECT v.player_id, v.player_name,
                to_char(v.expiration AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS current,
                g.granted,
                to_char(g.granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS granted_at,
                to_char(v.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
                g.granted_by
           FROM vips v JOIN last_set g ON g.player_id = v.player_id
          WHERE v.server_id = $1
            AND v.group_hold IS NULL
            AND NOT g.removed
            AND v.updated_at > g.granted_at
            AND v.expiration IS DISTINCT FROM (NULLIF(g.granted, '')::timestamptz)
          ORDER BY v.updated_at DESC`,
        [serverId, null],
      );
      return rows.map((r) => ({
        playerId: r.player_id,
        playerName: r.player_name,
        currentExpiration: r.current,
        grantedExpiration: r.granted || null,
        grantedAt: r.granted_at,
        grantedBy: r.granted_by,
        movedAt: r.updated_at,
        // Which way it moved, so a report can lead with the ones that handed out free VIP time.
        direction: r.current === null ? "made-permanent"
          : r.granted === null || r.granted === "" ? "given-an-expiry"
          : r.current > r.granted ? "extended" : "shortened",
      }));
    },
    restoreVipExpirations: async (serverId: string, playerIds: string[]) => {
      // The repair, and deliberately a narrow one: set each named VIP's expiration back to what its
      // newest `vip.grant` audit row says, and touch nothing else. Callers pass the exact ids from
      // vipsMovedByImport after a human has read them, so this never sweeps the table on its own.
      if (playerIds.length === 0) return [];
      // Only ever GIVES time back — a row cut short, or permanent VIP given an expiry. A row that
      // is longer than its last setting is never cut here: VIP is paid for, and an extension that
      // keeps its own record (a resumed VIP timeout, a rule's crash VIP) looks the same as one an
      // import made. Staff change those one at a time, by hand.
      const { rows } = await this.pool.query<{ player_id: string; restored: string | null }>(
        `WITH ${VIP_LAST_SET_CTE}
         UPDATE vips v SET expiration = NULLIF(g.granted, '')::timestamptz, updated_at = now()
           FROM last_set g
          WHERE v.server_id = $1 AND v.player_id = g.player_id
            AND v.group_hold IS NULL
            AND NOT g.removed
            AND v.updated_at > g.granted_at
            AND v.expiration IS NOT NULL
            AND (NULLIF(g.granted, '') IS NULL OR v.expiration < NULLIF(g.granted, '')::timestamptz)
         RETURNING v.player_id,
                   to_char(v.expiration AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS restored`,
        [serverId, playerIds],
      );
      return rows.map((r) => ({ playerId: r.player_id, restoredTo: r.restored }));
    },
    importedBreakdown: async (serverId: string) => {
      const cutoff = await this.events.firstLocalTs(serverId);
      const [kinds, profileActions, matches, stats, sessions] = await Promise.all([
        this.pool.query<{ kind: string; n: number }>(
          `SELECT kind, count(*)::int AS n FROM evt
            WHERE server_id = $1 AND dedupe_key LIKE 'crcon:%' AND dedupe_key NOT LIKE 'crcon:ra:%'
            GROUP BY kind`,
          [serverId],
        ),
        this.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM evt WHERE server_id = $1 AND dedupe_key LIKE 'crcon:ra:%'",
          [serverId],
        ),
        this.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM matches WHERE server_id = $1${cutoff ? " AND started_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        ),
        this.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM player_match_stats WHERE match_id IN
             (SELECT id FROM matches WHERE server_id = $1${cutoff ? " AND started_at < $2" : ""})`,
          cutoff ? [serverId, cutoff] : [serverId],
        ),
        this.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM player_sessions WHERE server_id = $1${cutoff ? " AND connected_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        ),
      ]);
      const eventsByKind: Record<string, number> = {};
      for (const r of kinds.rows) eventsByKind[r.kind] = r.n;
      return {
        cutoff, eventsByKind,
        profileActionEvents: profileActions.rows[0]!.n,
        matches: matches.rows[0]!.n, matchStats: stats.rows[0]!.n, sessions: sessions.rows[0]!.n,
      };
    },
    purgeServerData: async (serverId: string, opts?: { keepUserHistory?: boolean }) => {
      const keep = opts?.keepUserHistory === true;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Everything this server owns, live and imported alike. No cutoff, no provenance test:
        // this is the clean slate, for when the stored history is not worth telling apart from
        // what a re-import would rebuild. Server CONFIG is not touched — the connection, auto
        // settings, map-vote profiles, Discord wiring and staff accounts all survive.
        //
        // keepUserHistory carves out what belongs to the PLAYERS rather than to the server:
        // careers stay whole, and the moderation events (kicks, bans, punishes, admin messages,
        // camera watches) stay on the record — the final delete of a connection must not rewrite
        // what anyone earned or what was done to them.
        const stats = await client.query(
          "DELETE FROM player_match_stats WHERE match_id IN (SELECT id FROM matches WHERE server_id = $1)", [serverId]);
        const ma = await client.query("DELETE FROM matches WHERE server_id = $1", [serverId]);
        await client.query("DELETE FROM crcon_short_rounds WHERE server_id = $1", [serverId]);
        const ev = keep
          ? await client.query("DELETE FROM evt WHERE server_id = $1 AND kind != ALL($2::text[])", [serverId, TRIM_CATEGORIES.moderation ?? []])
          : await client.query("DELETE FROM evt WHERE server_id = $1", [serverId]);
        const se = await client.query("DELETE FROM player_sessions WHERE server_id = $1", [serverId]);
        await client.query("DELETE FROM open_sessions WHERE server_id = $1", [serverId]);
        const cam = await client.query("DELETE FROM admin_cam_sessions WHERE server_id = $1", [serverId]);
        const care = keep ? { rowCount: 0 } : await client.query("DELETE FROM player_stats WHERE server_id = $1", [serverId]);
        const bans = await client.query("DELETE FROM crcon_ban WHERE server_id = $1", [serverId]);
        const vips = await client.query("DELETE FROM vips WHERE server_id = $1", [serverId]);

        // Player-scoped records are install-wide, so they go only for players who now have no
        // presence ANYWHERE — which is automatically the whole set once the last server is wiped,
        // and correctly leaves the other server's players intact when only one is.
        //
        // The players rows themselves STAY. They are identities, not history: the Discord links,
        // group memberships and VIP economy balances hanging off them came from the old bot's
        // cutover import, not from CRCON, and no CRCON backup would bring them back. A re-import finds the
        // same identity by platform id and refills the history around it.
        // "No presence anywhere" has to include the records keyed on the PLATFORM id rather than
        // the row id — a VIP or a ban is enough to make a player someone another server still
        // knows, even with no history here. Leaving those two out would quietly strip the notes
        // and tags off a player who is only ever a VIP somewhere else.
        const orphan = `NOT EXISTS (SELECT 1 FROM player_stats s WHERE s.player_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM player_sessions s WHERE s.player_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM open_sessions o WHERE o.player_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM admin_cam_sessions c WHERE c.player_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM evt e WHERE e.actor_player_id = p.id OR e.victim_player_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM vips v WHERE v.player_id = p.platform_id)
                        AND NOT EXISTS (SELECT 1 FROM crcon_ban b WHERE b.player_id = p.platform_id)`;
        // With keepUserHistory the scrub is skipped outright: notes, tags, IPs, aliases and watch
        // records are user history too, and the kept careers make their owners non-orphans anyway.
        const scrub = async (table: string) =>
          keep ? 0 : (await client.query(`DELETE FROM ${table} t WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = t.player_id AND ${orphan})`)).rowCount ?? 0;
        const notes = await scrub("player_notes");
        const tags = await scrub("player_tags");
        const ips = await scrub("player_ips");
        const aliases = await scrub("player_aliases");
        const flags = await scrub("player_flags");
        await scrub("watch_history");
        await scrub("watch_reasons");

        await client.query("COMMIT");
        return {
          events: ev.rowCount ?? 0, matches: ma.rowCount ?? 0, matchStats: stats.rowCount ?? 0,
          sessions: se.rowCount ?? 0, cameraSessions: cam.rowCount ?? 0, careers: care.rowCount ?? 0,
          bans: bans.rowCount ?? 0, vips: vips.rowCount ?? 0,
          notes, tags, ips, aliases, watchlist: flags,
        };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    resetImportedHistory: async (serverId: string) => {
      const cutoff = await this.events.firstLocalTs(serverId);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Imported events out first — the career recount below reads what remains.
        const ev = await client.query("DELETE FROM evt WHERE server_id = $1 AND dedupe_key LIKE 'crcon:%'", [serverId]);
        // Imported rounds are the pre-cutoff ones (the transform's beforeCutoff gate guarantees
        // no import ever wrote a round in the live era). No cutoff = no live era = all imported.
        const stats = await client.query(
          `DELETE FROM player_match_stats WHERE match_id IN
             (SELECT id FROM matches WHERE server_id = $1${cutoff ? " AND started_at < $2" : ""})`,
          cutoff ? [serverId, cutoff] : [serverId],
        );
        const ma = await client.query(
          `DELETE FROM matches WHERE server_id = $1${cutoff ? " AND started_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        );
        await client.query(
          `DELETE FROM crcon_short_rounds WHERE server_id = $1${cutoff ? " AND started_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        );
        const se = await client.query(
          `DELETE FROM player_sessions WHERE server_id = $1${cutoff ? " AND connected_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        );
        const cam = await client.query(
          `DELETE FROM admin_cam_sessions WHERE server_id = $1${cutoff ? " AND entered_at < $2" : ""}`,
          cutoff ? [serverId, cutoff] : [serverId],
        );
        // Career recount from surviving evidence — the exact counters imported evidence fed, and
        // ONLY those. Buckets, role clocks, SL time and highest level came from live sampling and
        // are never touched; matches played/won live on settled rounds, which the delete above
        // already removed from history.
        const rec = await client.query(
          `UPDATE player_stats ps SET
             kills = COALESCE((SELECT count(*) FROM evt e WHERE e.server_id = ps.server_id AND e.actor_player_id = ps.player_id AND e.kind = 'evt.kill'), 0),
             teamkills = COALESCE((SELECT count(*) FROM evt e WHERE e.server_id = ps.server_id AND e.actor_player_id = ps.player_id AND e.kind = 'evt.teamkill'), 0),
             deaths = COALESCE((SELECT count(*) FROM evt e WHERE e.server_id = ps.server_id AND e.victim_player_id = ps.player_id AND e.kind IN ('evt.kill','evt.teamkill')), 0),
             visits = COALESCE((SELECT count(*) FROM evt e WHERE e.server_id = ps.server_id AND e.actor_player_id = ps.player_id AND e.kind = 'evt.player.connected'), 0),
             playtime_sec = COALESCE((SELECT sum(s.duration_sec) FROM player_sessions s WHERE s.server_id = ps.server_id AND s.player_id = ps.player_id), 0),
             updated_at = now()
           WHERE ps.server_id = $1`,
          [serverId],
        );
        await client.query("COMMIT");
        return {
          events: ev.rowCount ?? 0, matches: ma.rowCount ?? 0, matchStats: stats.rowCount ?? 0,
          sessions: se.rowCount ?? 0, cameraSessions: cam.rowCount ?? 0, playersRecounted: rec.rowCount ?? 0,
        };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    latestJob: async (serverId: string): Promise<CrconImportJobRow | null> => {
      const { rows } = await this.pool.query("SELECT * FROM crcon_import_job WHERE server_id = $1 ORDER BY created_at DESC LIMIT 1", [serverId]);
      return rows[0] ? toCrconJob(rows[0]) : null;
    },
    listJobs: async (serverId?: string): Promise<CrconImportJobRow[]> => {
      const { rows } = serverId
        ? await this.pool.query("SELECT * FROM crcon_import_job WHERE server_id = $1 ORDER BY created_at DESC", [serverId])
        : await this.pool.query("SELECT * FROM crcon_import_job ORDER BY created_at DESC");
      return rows.map(toCrconJob);
    },
    updateJob: async (id: string, patch: CrconImportJobPatch): Promise<CrconImportJobRow | null> => {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (patch.status !== undefined) { args.push(patch.status); sets.push(`status = $${args.length}`); }
      if (patch.cursor !== undefined) { args.push(JSON.stringify(patch.cursor)); sets.push(`cursor = $${args.length}`); }
      if (patch.counts !== undefined) { args.push(JSON.stringify(patch.counts)); sets.push(`counts = $${args.length}`); }
      if (patch.errors !== undefined) { args.push(JSON.stringify(patch.errors)); sets.push(`errors = $${args.length}`); }
      if (patch.baseUrl !== undefined) { args.push(patch.baseUrl); sets.push(`base_url = $${args.length}`); }
      if (patch.apiKey !== undefined) { args.push(patch.apiKey); sets.push(`api_key = $${args.length}`); }
      sets.push("updated_at = now()");
      args.push(id);
      const { rows } = await this.pool.query(`UPDATE crcon_import_job SET ${sets.join(", ")} WHERE id = $${args.length} RETURNING *`, args);
      return rows[0] ? toCrconJob(rows[0]) : null;
    },
  };

  heartbeats = {
    upsert: async (input: { name: string; status: string; detail?: Record<string, unknown> | null }): Promise<HeartbeatRow> => {
      const { rows } = await this.pool.query(
        `INSERT INTO service_heartbeats (name, status, detail, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()
         RETURNING *`,
        [input.name, input.status, input.detail ?? null],
      );
      return toHeartbeat(rows[0]);
    },
    list: async (): Promise<HeartbeatRow[]> => {
      const { rows } = await this.pool.query("SELECT * FROM service_heartbeats ORDER BY name");
      return rows.map(toHeartbeat);
    },
  };

  audit = {
    create: async (input: NewAudit): Promise<AuditRow> => {
      const { rows } = await this.pool.query(
        // automated is decided HERE and never re-derived: a human always acts through an account,
        // the app never does. Storing it now is what keeps a deleted admin's history human.
        `INSERT INTO audit (id, actor_user_id, actor_name, action, target_type, target_id, target_name, server_id, summary, data, automated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(), input.actorUserId ?? null, input.actorName, input.action, input.targetType ?? null, input.targetId ?? null, input.targetName ?? null, input.serverId ?? null, input.summary, input.data ?? null, input.actorUserId == null],
      );
      const row = toAudit(rows[0]);
      for (const w of this.auditWatchers) {
        try { w(structuredClone(row)); } catch { /* the row stands whatever a listener does */ }
      }
      return row;
    },
    watch: (listener: (row: AuditRow) => void): (() => void) => {
      this.auditWatchers.add(listener);
      return () => { this.auditWatchers.delete(listener); };
    },
    count: async (query: AuditQuery = {}): Promise<number> => {
      const { where, args } = auditWhere(query);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM audit ${whereSql}`, args);
      return rows[0]?.n ?? 0;
    },
    get: async (id: string): Promise<AuditRow | null> => {
      const { rows } = await this.pool.query(`SELECT * FROM audit WHERE id = $1`, [id]);
      return rows[0] ? toAudit(rows[0]) : null;
    },
    list: async (query: AuditQuery = {}): Promise<AuditRow[]> => {
      const { where, args } = auditWhere(query);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      args.push(Math.min(query.limit ?? 100, 500));
      const limitP = `$${args.length}`;
      args.push(Math.max(query.offset ?? 0, 0));
      // id breaks ts ties so a page boundary can't drop or repeat an entry.
      const dir = query.order === "asc" ? "ASC" : "DESC";
      const { rows } = await this.pool.query(
        `SELECT * FROM audit ${whereSql} ORDER BY ts ${dir}, id ${dir} LIMIT ${limitP} OFFSET $${args.length}`,
        args,
      );
      return rows.map(toAudit);
    },
    vipTimeline: async (cursor: string | null, limit: number, scope: { serverId?: string; before?: string } = {}): Promise<{ rows: AuditRow[]; next: string | null }> => {
      // The predicate is the partial index's own (migration 137, audit_vip_timeline_idx), so the
      // read walks that index in (ts, id) order and touches only the VIP slice of the trail. The
      // cursor is the last row's stored ts as text (microseconds — a JS Date would round them off
      // and repeat or skip rows at a page boundary) plus its id to break ties.
      const args: unknown[] = [];
      let after = "";
      const sep = cursor ? cursor.lastIndexOf("|") : -1;
      if (cursor && sep > 0) {
        args.push(cursor.slice(0, sep), cursor.slice(sep + 1));
        after = "AND (ts, id) > ($1::timestamptz, $2::uuid)";
      }
      // A resume lists the servers it banked time back on in its data, so it rides along unfiltered.
      if (scope.serverId) { args.push(scope.serverId); after += ` AND (server_id = $${args.length} OR action = 'player.vipresume')`; }
      if (scope.before) { args.push(scope.before); after += ` AND ts < $${args.length}`; }
      args.push(Math.max(1, Math.min(limit, 10_000)));
      const { rows } = await this.pool.query(
        `SELECT *, ts::text AS cursor_ts FROM audit
          WHERE (${VIP_TIMELINE_SQL}) ${after}
          ORDER BY ts, id LIMIT $${args.length}`,
        args,
      );
      const last = rows[rows.length - 1];
      return { rows: rows.map(toAudit), next: rows.length === args[args.length - 1] && last ? `${last.cursor_ts}|${last.id}` : null };
    },
    vipGrantsByRef: async (refs: string[]): Promise<AuditRow[]> => {
      if (!refs.length) return [];
      // The predicate is the partial index's own (migration 158, audit_vip_grant_ref_idx).
      const { rows } = await this.pool.query(
        `SELECT * FROM audit WHERE action = 'vip.grant' AND data->>'ref' = ANY($1::text[]) ORDER BY ts, id`,
        [refs],
      );
      return rows.map(toAudit);
    },
    staffSummary: async (range: { from?: string; to?: string; serverIds?: string[]; includeUnscoped?: boolean; actor?: "human" | "auto" } = {}): Promise<StaffSummaryRow[]> => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (range.from) { args.push(range.from); where.push(`ts >= $${args.length}`); }
      if (range.to) { args.push(range.to); where.push(`ts < $${args.length}`); }
      // Same rule as the trail itself: a view-level narrowing keeps community-wide work in the
      // count, or a moderator's group and template edits vanish from their own totals.
      if (range.serverIds) { args.push(range.serverIds); where.push(range.includeUnscoped ? `(server_id = ANY($${args.length}) OR server_id IS NULL)` : `server_id = ANY($${args.length})`); }
      // The flag stored at write time — NOT actor_user_id, which goes null when an account is
      // deleted and would reclassify a departed admin's work as machinery.
      if (range.actor === "human") where.push("automated = false");
      if (range.actor === "auto") where.push("automated = true");
      // One act, one count — the same rule the analytics pages apply in JS (countableActions):
      // a continuation row carries on a decision already counted, and a bulk volley's per-target
      // rows collapse to one per (actor, action, server, UTC minute). This rollup aggregates in
      // SQL over a trail with years in it, so the rule has to live in the query: one select-all
      // message to a hundred players is one act of staffing, not a hundred.
      // COALESCE, not a bare NOT: `data ? 'continues'` is NULL for rows with no data at all,
      // and NULL would filter every plain row out with them.
      where.push("NOT COALESCE(data ? 'continues', false)");
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { rows } = await this.pool.query(
        // actor_name is in the GROUP BY, not a max(): departed staff all carry actor_user_id NULL,
        // so grouping on the id alone folded every one of them into a single row wearing whichever
        // name sorted highest. A live account's rows are re-merged by id below, so a rename never
        // splits one present person in two.
        `SELECT actor_user_id, actor_name, action,
                count(DISTINCT CASE WHEN (data->>'bulk')::boolean IS TRUE
                                    THEN 'v|' || coalesce(server_id::text, '') || '|' || to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
                                    ELSE id::text END)::int AS n,
                max(ts) AS last_at
         FROM audit ${whereSql} GROUP BY actor_user_id, actor_name, action`,
        args,
      );
      const by = new Map<string, StaffSummaryRow>();
      for (const r of rows) {
        const key = r.actor_user_id ?? `name:${r.actor_name}`;
        const s: StaffSummaryRow = by.get(key) ?? { actorUserId: r.actor_user_id ?? null, actorName: r.actor_name, count: 0, lastAt: new Date(r.last_at).toISOString(), byAction: {} };
        s.count += r.n;
        s.byAction[r.action] = (s.byAction[r.action] ?? 0) + r.n;
        if (new Date(r.last_at).toISOString() > s.lastAt) s.lastAt = new Date(r.last_at).toISOString();
        by.set(key, s);
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
  };

  pluginKv = {
    get: async (namespace: string, key: string): Promise<unknown> => {
      const { rows } = await this.pool.query("SELECT value FROM plugin_kv WHERE namespace = $1 AND key = $2", [namespace, key]);
      return rows[0] ? rows[0].value : undefined;
    },
    set: async (namespace: string, key: string, value: unknown, at?: string): Promise<void> => {
      await this.pool.query(
        `INSERT INTO plugin_kv (namespace, key, value, updated_at) VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()))
         ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [namespace, key, JSON.stringify(value ?? null), at ?? null],
      );
    },
    remove: async (namespace: string, key: string): Promise<void> => {
      await this.pool.query("DELETE FROM plugin_kv WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
  };
}

/**
 * How long a database connection may sit unused before the pool closes it. node-postgres closes one
 * after 10 seconds, sooner than the gaps between the app's own polls (the panel's every 15 seconds,
 * the worker's loops every 10 to 60), so connections were closed and reopened all day: measured on
 * one busy server, 278 new connections in 8 minutes, each costing 9.3 ms and a password handshake
 * against 0.19 ms for a query on a connection kept open. Ten minutes outlasts every poll, and a pool
 * left alone that long (a quiet night) still gives its connections back.
 */
const POOL_IDLE_MS = 10 * 60_000;

/** Build a Postgres repository from a connection string and run migrations. */
export async function createPostgresRepository(connectionString: string): Promise<PostgresRepository> {
  // keepAlive lets the client notice a dead server promptly; the server-side counterpart
  // (tcp_keepalives_* in docker-compose) reaps sessions whose client vanished without a FIN.
  const pool = new Pool({
    connectionString, keepAlive: true, idleTimeoutMillis: POOL_IDLE_MS,
    // No JIT. Postgres compiles a query it costs as expensive into machine code first, and for
    // this app's reads — a page of the players list, an analytics window — the compiling took
    // longer than the query: the players search ran in 170ms without it and 460-600ms with it, the
    // list sorted by kills 430ms against 740ms, and nothing read was faster for it. Set as each
    // connection opens, before the pool hands it out (onConnect is waited for), rather than as
    // `options` in the connection string, which a pooler can refuse and which carries the test
    // schemas' search_path already (isolated.ts). A server that refuses it keeps its own setting.
    onConnect: (client) => client.query("SET jit = off").then(() => undefined, () => undefined),
  });
  // A connection that drops while it sits idle (Postgres restarted, the network blinked) is reported
  // on the pool, and an 'error' nobody listens for ends the process. The pool has already let that
  // connection go and the next query opens a fresh one, so this says so and carries on.
  pool.on("error", (err) => log.warn("an idle database connection dropped; the next query opens a new one", { err: err.message }));
  const repo = new PostgresRepository(pool);
  await repo.migrate();
  // Opportunistic upgrade: with ENCRYPTION_KEY set, seal any RCON passwords still stored as
  // plaintext (rows from before encryption-at-rest, or created while the key was unset).
  const key = process.env.ENCRYPTION_KEY ?? "";
  if (key) {
    const { rows } = await pool.query("SELECT id, password FROM servers WHERE password NOT LIKE 'enc:v1:%'");
    for (const r of rows) {
      if (isSealed(r.password)) continue;
      await pool.query("UPDATE servers SET password = $2 WHERE id = $1", [r.id, sealSecret(r.password, key)]);
    }
    if (rows.length > 0) log.info("sealed plaintext server passwords at rest", { count: rows.length });
  }
  return repo;
}
