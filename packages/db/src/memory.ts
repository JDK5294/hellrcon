/**
 * In-memory Repository implementation — used for dev, tests, and a zero-setup demo.
 * The same Repository interface is backed by Postgres in production (schema.sql).
 */
import { randomUUID } from "node:crypto";
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
  RosterSampleRow,
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
  PlayerStatsRow,
  PlayerTagRow,
  Repository,
  RoleAssignment,
  RoleRow,
  RulePatch,
  RuleRow,
  RuleSectionRow,
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
  DataPortReport,
  TrimSpec,
  UserRow,
  VipRow,
  VipGroupHoldSource,
  GroupVipPerk,
  NewPlayerTrigger,
  PlayerTriggerRow,
  PlayerTriggerEdit,
  VipPause,
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
  ImportedSession,
} from "./types.js";
import { InsufficientBalance, RuleSectionNameTaken, GROUP_EVENT_CLAIM_MS, CONFIG_VERSIONS_KEPT, MIN_MATCH_MS, storedVipExpiration, VIP_TIMELINE_ACTIONS, VIP_TIMELINE_EXPIRY_ACTIONS, type VipGroupHold, type ConfigVersionKind, type ConfigVersionRow, type NewConfigVersion } from "./types.js";
import { HOUR_METRIC_KINDS, foldHourGrid, hourAverage, localHourKey, wholeOrNull, type DateHourRow, type HourMetric } from "./types.js";
import { computeKd, isPermanentKvKey, ECONOMY_ACTIVITY_KINDS, TRIM_CATEGORIES, economyActivityKind, EVENT_POST_DEFAULTS, occupancySampleSec, foldOccupancy, foldComposition, TORN_SESSION_SEC, SESSION_MAX_SEC, GAME_SLOT_CAP, blendMeasuredConcurrency, platformFamilyTokens, normalizePlatformToken, emptyPlatformSums, emptyPlatformTrendRow, ANNOUNCEMENT_NUDGE_DEFAULTS, BROADCAST_DEFAULTS, WELCOME_DEFAULTS, mergeGameRewards, AUTOSETTINGS_DEFAULTS, DISCORD_RELAY_DEFAULTS, DISCORD_STATUS_BOARD_DEFAULTS, SEEDING_DEFAULTS, ADMIN_CAM_DEFAULTS, SIGNATURE_DEFAULTS, ECONOMY_DEFAULTS, ECONOMY_LEDGER_PAGE, DISCORD_COMMAND_DEFAULTS, APP_CONFIG_DEFAULTS, CHAT_FILTER_DEFAULTS, safeTimezone, blankMapVoteState } from "./types.js";
import { backupRowsNdjson } from "./backup.js";
import { hydrateLinks } from "./map-library.js";
import { codeOrder } from "./map-points.js";
import { parseSignatureActions } from "@app/shared";
import { SEED_MAP_SETS, SEED_VOTE_SCHEDULES } from "./seed/map-sets.js";
import { CLAN_CURRENT_GRACE_SEC } from "./clan-tags.js";
// One timezone implementation in the repo: @app/schedule's, the same one the map-vote and
// auto-settings windows use. It falls back to UTC on an unusable zone rather than throwing.
import { WEEKDAYS as WEEKDAY_ORDER, zonedParts } from "@app/schedule";

/** Mirrors the Postgres store's threshold exactly — the two must agree or the same data reports a
 *  different early-leaver rate depending on which store answered. */
const SHORT_SESSION_SEC = 300;

/** The platform split's per-session and per-round sums — the Postgres store's two column lists,
 *  in this one's terms. Distinct counts (players, new players) are set by the caller from sets. */
function foldMemorySession(row: PlatformSums, r: PlayerSessionRow): void {
  row.sessions += 1;
  row.playtimeSec += r.durationSec ?? 0;
  if (r.durationSec < SHORT_SESSION_SEC) row.shortSessions += 1;
}
function foldMemoryRound(row: PlatformSums, st: PlayerMatchStatRow): void {
  row.rounds += 1;
  row.kills += st.kills; row.deaths += st.deaths;
  row.teamkills += st.teamkills; row.vehicleKills += st.vehicleKills;
  if (st.combat + st.offense + st.defense + st.support > 0) row.scoredRounds += 1;
  row.combat += st.combat; row.offense += st.offense; row.defense += st.defense; row.support += st.support;
  row.slSeconds += st.slSeconds;
}

/** Grant levels in strength order — the Postgres store's `level = ANY(at least)` in this one's terms. */
const LEVEL_ORDER: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

/** Who a score says won. A draw and an unknown score both mean "nobody named" — mirrors the CASE
 *  in the Postgres store's `matches.close`. */
function scoreWinner(allied: number | null, axis: number | null): "allies" | "axis" | null {
  if (allied === null || axis === null || allied === axis) return null;
  return allied > axis ? "allies" : "axis";
}

export class InMemoryRepository implements Repository {
  /**
   * Count imported events instead of keeping them (the CRCON dry run, and nothing else).
   *
   * A dry run exists to report what an Apply WOULD land, so it runs the real transform into a
   * throwaway store — but a full CRCON history is tens of millions of events, and holding a row
   * object for each costs several gigabytes and exhausts the heap before the report is reached.
   * Nothing needs those bodies: the transform only reads back `events.firstLocalTs`, which
   * deliberately ignores `crcon:`-keyed rows, so an imported event is written once and never
   * looked at again. Dedupe still runs (the returned count has to match what Apply would insert),
   * and locally-recorded events are still stored in full — including the synthetic one the dry run
   * seeds at the real cutoff, which is what firstLocalTs answers with.
   *
   * Leave this off everywhere else: with it on, the event read paths see only local events.
   */
  private readonly countImportedEvents: boolean;

  constructor(opts: { countImportedEvents?: boolean } = {}) {
    this.countImportedEvents = opts.countImportedEvents ?? false;
  }

  private usersById = new Map<string, UserRow>();
  private prefsByUser = new Map<string, Record<string, unknown>>(); // display prefs, per account
  private usersByName = new Map<string, UserRow>();
  private tokensByHash = new Map<string, ApiTokenRow>();
  private pushByEndpoint = new Map<string, PushSubscriptionRow>();
  private serversById = new Map<string, ServerRow>();
  private grantsByUser = new Map<string, GrantRow[]>();
  private limitsByUser = new Map<string, Record<string, number>>();
  private rolesById = new Map<string, RoleRow>();
  /** userId → (roleId|scopeId) → assignment. */
  private rolesByUser = new Map<string, Map<string, RoleAssignment>>();
  private playersById = new Map<string, PlayerRow>();
  private playersByPlatform = new Map<string, PlayerRow>();
  private aliasesByPlayer = new Map<string, PlayerAliasRow[]>(); // name + clan-tag history
  private tagsByPlayer = new Map<string, PlayerTagRow[]>(); // custom flags/tags
  private linksByKey = new Map<string, ExternalLinkRow>(); // `${playerId}|${provider}`
  private rosterSnaps: RosterSnapshotRow[] = [];
  private rosterSnapSeq = 0;
  private openSessions = new Map<string, string>(); // `${playerId}|${serverId}` → connectedAt
  private sessionsByPlayer = new Map<string, PlayerSessionRow[]>(); // completed session history
  private evts: EvtRow[] = [];
  private evtDedupe = new Set<string>(); // `${serverId}|${dedupeKey}` of stored events
  /** Imported events counted but not stored under `countImportedEvents`; 0 otherwise. */
  private importedEvtCount = 0;
  private statsByPlayer = new Map<string, PlayerStatsRow>();
  private ruleStatus = new Map<string, RuleStatusRow>(); // `${ruleId}|${serverId}`
  private ruleFirings: { ruleId: string; playerId: string; dryRun: boolean; firedAt: string }[] = [];
  /** Scheduled rules' claimed occurrences, `${ruleId}|${occurrence}` (rule_occurrences). */
  private ruleOccurrences = new Set<string>();
  private announcementsById = new Map<string, AnnouncementRow>();
  private announcementReadsByKey = new Map<string, AnnouncementReadRow>(); // key: `${announcementId}|${userId}`
  private nudgeConfig: AnnouncementNudgeConfig | null = null;
  private templatesById = new Map<string, MessageTemplateRow>();
  private vipPresetsById = new Map<string, VipPresetRow>();
  private layoutsByKey = new Map<string, LayoutRow>();
  private vipsByKey = new Map<string, VipRow>(); // key: `${serverId}|${playerId}`
  private playerTriggersById = new Map<string, PlayerTriggerRow>();
  private consoleAdminsByKey = new Map<string, ConsoleAdminRow>(); // key: `${serverId}|${playerId}`
  private playerGroupsById = new Map<string, Omit<PlayerGroupRow, "memberCount">>();
  private playerGroupMembersByKey = new Map<string, PlayerGroupMemberRow>(); // key: `${groupId}|${playerId}`
  /** Membership changes waiting for the rule engine, oldest first (see playerGroups.takeEvents). */
  /** Queued membership changes; `claimedAt` marks one a drain has taken and not yet finished. */
  private playerGroupEvents: (PlayerGroupEventRow & { claimedAt?: string | null })[] = [];
  private seedingConfigs = new Map<string, SeedingConfigRow>(); // key: serverId
  private broadcastConfigs = new Map<string, BroadcastConfigRow>(); // key: serverId
  private welcomeConfigs = new Map<string, WelcomeConfigRow>(); // key: serverId
  private gameRewardConfigs = new Map<string, GameRewardsConfigRow>(); // key: serverId
  private gameRewardReceipts = new Set<string>(); // serverId|ref|playerId
  private gameRewardDays = new Map<string, number>(); // serverId|playerId|kind|day → seconds
  private autoSettingsConfigs = new Map<string, AutoSettingsConfigRow>();
  private autoSettingsTemplates = new Map<string, AutoSettingsTemplateRow>(); // key: template id (community-wide)
  private featurePresetRows = new Map<string, FeaturePresetRow>();
  private discordRelayConfigs = new Map<string, DiscordRelayConfigRow>(); // key: serverId
  private seedProgress = new Map<string, SeedProgressRow>(); // key: `${serverId}|${playerId}`
  private seedingStates = new Map<string, SeedingStateRow>(); // key: serverId
  private seedCycles = new Map<string, SeedCycleRecord>(); // key: serverId
  private seedPayRequests = new Set<string>(); // serverIds with a pending pay-last request
  private mapLayoutVotes = new Map<string, MapLayoutRow>(); // key: lowercased map id
  private mapLayoutRounds = new Map<string, string>(); // key: lowercased map id → last voting match
  private mapNamesByKey = new Map<string, MapNameRow>(); // key: `${game}|${mapId}`
  private objectivePointsByKey = new Map<string, ObjectivePointRow>(); // key: `${game}|${mapKey}|${row}|${idx}`
  private layoutExpiriesByKey = new Map<string, ObjectiveLayoutExpiryRow>(); // key: `${serverId}|${mapId}`
  private mapPointPendingByServer = new Map<string, MapPointPendingRow>(); // key: serverId
  private mapVoteConfigs = new Map<string, MapVoteConfigRow>(); // key: serverId
  private signatureConfig: SignatureConfigRow = { ...SIGNATURE_DEFAULTS, actions: {}, updatedAt: new Date(0).toISOString() };
  private adminCamSessions: AdminCamSessionRow[] = [];
  private adminCamConfigs = new Map<string, AdminCamConfigRow>(); // key: serverId
  private mapSetsById = new Map<string, MapSetRow>();
  /** Version history, oldest first; `seq` orders saves made in the same millisecond. */
  private configVersionRows: (ConfigVersionRow & { seq: number })[] = [];
  private configVersionSeq = 0;
  private mapZoneSetsById = new Map<string, MapZoneSetRow>();
  private voteSchedulesById = new Map<string, VoteScheduleRow>();
  private mapVoteStates = new Map<string, MapVoteStateRow>();
  private mapVoteHistory: MapVoteHistoryRow[] = [];
  private mapVoteBallots: MapVoteBallotRow[] = [];
  private crconBansByKey = new Map<string, CrconBanRow>(); // key: serverId|playerId|type
  private economyMembers = new Map<string, CommunityMemberRow>();
  private economyEntries: EconomyLedgerRow[] = [];
  private economyRefs = new Map<string, EconomyLedgerRow>();
  private economyConfig: EconomyConfig = { ...JSON.parse(JSON.stringify(ECONOMY_DEFAULTS)) as typeof ECONOMY_DEFAULTS, updatedAt: new Date(0).toISOString() };
  private discordCommandConfig: DiscordCommandConfig = { ...JSON.parse(JSON.stringify(DISCORD_COMMAND_DEFAULTS)) as typeof DISCORD_COMMAND_DEFAULTS, updatedAt: new Date(0).toISOString() };
  private playerBansById = new Map<string, PlayerBanRow>();
  private matchesById = new Map<string, MatchRow>();
  /** The short rounds only the CRCON-compatible endpoints list (crcon_short_rounds), by seq. */
  private crconShortRounds = new Map<number, { serverId: string; row: CrconRoundRow; players?: CrconPlayerCache | null }>();
  /** CRCON's per-round player cache, by match id (crcon_player_stats). */
  private crconPlayerStats = new Map<string, CrconPlayerCache>();
  /** Each round's score series, by match id then player id (match_score_series). */
  private scoreSeriesByMatch = new Map<string, Map<string, number[]>>();
  /** Next public integer alias for a match — mirrors Postgres's matches_seq sequence. */
  private nextMatchSeq = 1;
  private matchStatsByKey = new Map<string, PlayerMatchStatRow>(); // key: matchId|playerId
  /** Rounds whose sampled scores have reached careers — Postgres's matches.scores_credited (see
   *  MIN_MATCH_MS: careers wait until a round has run long enough to be a game). */
  private matchScoresCredited = new Set<string>();
  // key: matchId|playerId|weapon — the weapon-kill rollup, plus the stamp saying a round was
  // visited (kept apart from the rows: "zero rows" and "never looked" must stay different).
  private matchWeaponKills = new Map<string, { matchId: string; playerId: string; serverId: string; weapon: string; classId: string; kills: number; deaths: number }>();
  private weaponRollupDone = new Set<string>();

  /** Weapon-kill rows and rollup stamps follow their matches out — Postgres does this via FK
   *  cascade; here it is explicit at every match-deletion site. */
  /** A server's rounds as the CRCON-compatible endpoints list them, newest first. */
  private crconRoundsOf(serverId: string): CrconRoundRow[] {
    return [
      ...[...this.matchesById.values()].filter((m) => m.serverId === serverId).map((m) => this.crconRoundOf(m)),
      ...[...this.crconShortRounds.values()].filter((r) => r.serverId === serverId).map((r) => ({ ...r.row })),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.seq - a.seq);
  }

  /** A round as the CRCON-compatible endpoints list it (CrconRoundRow). */
  private crconRoundOf(m: MatchRow): CrconRoundRow {
    return {
      matchId: m.id, short: false, seq: m.seq, game: m.game, map: m.map, crconMap: m.crconMap, crconGuessed: m.crconGuessed,
      crconInitialMorale: m.crconInitialMorale, crconEndDeferred: m.crconEndDeferred, startedAt: m.startedAt, endedAt: m.endedAt,
      capFlips: m.capFlips, moraleHistory: m.moraleHistory, matchTime: m.matchTime, sectorLayout: m.sectorLayout,
      alliedScore: m.alliedScore, axisScore: m.axisScore, result: m.result, createdAt: m.createdAt, settledAt: m.settledAt,
    };
  }

  private dropWeaponKills(matchIds: Set<string>): void {
    for (const [k, r] of this.matchWeaponKills) if (matchIds.has(r.matchId)) this.matchWeaponKills.delete(k);
    for (const id of matchIds) this.weaponRollupDone.delete(id);
  }
  private discordRoleMapByKey = new Map<string, DiscordRoleMapRow>(); // key: discordRoleId|roleId
  private crconJobsById = new Map<string, CrconImportJobRow>();
  private crconJobKeys = new Map<string, string>(); // jobId → CRCON api key (kept off the row so it can't leak)
  private heartbeatsByName = new Map<string, HeartbeatRow>();
  // Value plus when it was written: the retention sweep ages rows out by that stamp, and a
  // store that could not answer "how old is this?" would have to lie about what it trimmed.
  private pluginKvByKey = new Map<string, { value: unknown; updatedAt: string }>();
  private auditLog: AuditRow[] = [];
  private auditWatchers = new Set<(row: AuditRow) => void>();
  private notesByPlayer = new Map<string, PlayerNoteRow[]>();
  private flagsByPlayer = new Map<string, PlayerFlagsRow>();
  private watchHistoryRows: WatchHistoryRow[] = []; // every watch spell ever, never deleted
  private rulesById = new Map<string, RuleRow>();
  private ruleSectionsById = new Map<string, RuleSectionRow>();
  /** `${ruleId}|${serverId}|${playerId}` → when that rule last granted them a crash VIP. */
  private vipGrantAt = new Map<string, string>();

  users = {
    create: async (input: { username: string; passwordHash?: string | null; email?: string | null; discordId?: string | null; discordUsername?: string | null; discordNick?: string | null; discordManaged?: boolean }): Promise<UserRow> => {
      if (this.usersByName.has(input.username.toLowerCase())) {
        throw new Error(`username already exists: ${input.username}`);
      }
      const row: UserRow = {
        id: randomUUID(),
        username: input.username,
        passwordHash: input.passwordHash ?? null,
        email: input.email ?? null,
        discordId: input.discordId ?? null,
        discordUsername: input.discordUsername ?? null,
        discordNick: input.discordNick ?? null,
        discordManaged: input.discordManaged ?? false,
        announcementsSeenAt: null,
        sessionEpoch: 0,
        createdAt: new Date().toISOString(),
      };
      this.usersById.set(row.id, row);
      this.usersByName.set(row.username.toLowerCase(), row);
      return row;
    },
    findById: async (id: string) => this.usersById.get(id) ?? null,
    findByUsername: async (username: string) => this.usersByName.get(username.toLowerCase()) ?? null,
    findByDiscordId: async (discordId: string) => [...this.usersById.values()].find((u) => u.discordId === discordId) ?? null,
    firstUserId: async () => {
      // Earliest createdAt wins. Sort is stable, so a same-millisecond tie (memory timestamps are
      // only that fine) falls back to Map insertion order — which IS creation order here, where
      // the SQL store's microsecond created_at needs the id tie-break instead.
      const first = [...this.usersById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return first?.id ?? null;
    },
    count: async () => this.usersById.size,
    list: async () => [...this.usersById.values()].sort((a, b) => a.username.localeCompare(b.username)),
    listDiscordLinked: async () => [...this.usersById.values()].filter((u) => u.discordId),
    linkDiscord: async (id: string, input: { discordId: string; username?: string | null; nick?: string | null; managed?: boolean }) => {
      const row = this.usersById.get(id);
      if (!row) return null;
      row.discordId = input.discordId;
      // Only overwrite a name we were actually given, so a partial refresh never blanks the other.
      if (input.username !== undefined) row.discordUsername = input.username;
      if (input.nick !== undefined) row.discordNick = input.nick;
      if (input.managed !== undefined) row.discordManaged = input.managed;
      return row;
    },
    setAnnouncementsSeen: async (id: string): Promise<void> => {
      const row = this.usersById.get(id);
      if (row) row.announcementsSeenAt = new Date().toISOString();
    },
    getPrefs: async (id: string): Promise<Record<string, unknown>> => ({ ...(this.prefsByUser.get(id) ?? {}) }),
    setPrefs: async (id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const merged = { ...(this.prefsByUser.get(id) ?? {}), ...patch };
      this.prefsByUser.set(id, merged);
      return { ...merged };
    },
    setDiscordManaged: async (id: string, managed: boolean) => {
      const row = this.usersById.get(id);
      if (!row) return null;
      row.discordManaged = managed;
      return row;
    },
    revokeSessions: async (id: string): Promise<number | null> => {
      const row = this.usersById.get(id);
      if (!row) return null;
      row.sessionEpoch += 1;
      return row.sessionEpoch;
    },
    remove: async (id: string) => {
      const row = this.usersById.get(id);
      if (!row) return false;
      this.usersById.delete(id);
      this.usersByName.delete(row.username.toLowerCase());
      this.grantsByUser.delete(id);
      this.limitsByUser.delete(id);
      this.rolesByUser.delete(id);
      for (const [hash, t] of this.tokensByHash) if (t.userId === id) this.tokensByHash.delete(hash);
      for (const [endpoint, d] of this.pushByEndpoint) if (d.userId === id) this.pushByEndpoint.delete(endpoint);
      // Match Postgres' `ON DELETE SET NULL`: the audit trail is a permanent record, so the rows
      // survive a deleted account — they just lose the link and fall back to `actorName`, the last
      // known name at the time of each action. Without this the in-memory store left a dangling id
      // that still rendered as a link to a profile that no longer exists.
      for (const a of this.auditLog) if (a.actorUserId === id) a.actorUserId = null;
      return true;
    },
    setPassword: async (id: string, passwordHash: string) => {
      const row = this.usersById.get(id);
      if (!row) return false;
      row.passwordHash = passwordHash;
      return true;
    },
    merge: async (survivorId: string, duplicateId: string) => {
      if (survivorId === duplicateId) return null;
      const survivor = this.usersById.get(survivorId);
      const dup = this.usersById.get(duplicateId);
      if (!survivor || !dup) return null;
      // History moves to the survivor (mirrors the Postgres UPDATEs).
      for (const a of this.auditLog) {
        if (a.actorUserId === duplicateId) a.actorUserId = survivorId;
        if (a.targetType === "user" && a.targetId === duplicateId) a.targetId = survivorId;
      }
      for (const list of this.notesByPlayer.values()) for (const n of list) if (n.authorUserId === duplicateId) n.authorUserId = survivorId;
      for (const ann of this.announcementsById.values()) if (ann.authorUserId === duplicateId) ann.authorUserId = survivorId;
      // Read receipts: keep the earliest read/ack per notice across the two accounts.
      for (const [key, r] of [...this.announcementReadsByKey]) {
        if (r.userId !== duplicateId) continue;
        this.announcementReadsByKey.delete(key);
        const sKey = `${r.announcementId}|${survivorId}`;
        const mine = this.announcementReadsByKey.get(sKey);
        if (!mine) {
          this.announcementReadsByKey.set(sKey, { ...r, userId: survivorId });
        } else {
          if (r.readAt < mine.readAt) mine.readAt = r.readAt;
          if (r.acknowledgedAt && (!mine.acknowledgedAt || r.acknowledgedAt < mine.acknowledgedAt)) mine.acknowledgedAt = r.acknowledgedAt;
        }
      }
      // Transfer the Discord identity to a survivor that lacks one, then drop the duplicate —
      // clear its discordId first so the merged history can't be found under the dead account.
      const identity = !survivor.discordId && dup.discordId
        ? { discordId: dup.discordId, discordUsername: dup.discordUsername, discordNick: dup.discordNick, discordManaged: dup.discordManaged }
        : null;
      if ((dup.announcementsSeenAt ?? "") > (survivor.announcementsSeenAt ?? "")) survivor.announcementsSeenAt = dup.announcementsSeenAt;
      dup.discordId = null;
      await this.users.remove(duplicateId);
      if (identity) Object.assign(survivor, identity);
      return survivor;
    },
  };

  discordRoleMap = {
    list: async (): Promise<DiscordRoleMapRow[]> =>
      [...this.discordRoleMapByKey.values()].sort((a, b) => (a.discordRoleName ?? a.discordRoleId).localeCompare(b.discordRoleName ?? b.discordRoleId)),
    setForDiscordRole: async (discordRoleId: string, discordRoleName: string | null, assignments: RoleAssignment[]): Promise<void> => {
      for (const [k, v] of this.discordRoleMapByKey) if (v.discordRoleId === discordRoleId) this.discordRoleMapByKey.delete(k);
      for (const a of assignments) {
        // The scope is part of the key: the same panel role may be granted globally AND on a
        // specific server, and those are two different rows.
        this.discordRoleMapByKey.set(`${discordRoleId}|${a.roleId}|${a.scopeId ?? ""}`, {
          discordRoleId, discordRoleName, roleId: a.roleId, scopeId: a.scopeId, createdAt: new Date().toISOString(),
        });
      }
    },
    remove: async (discordRoleId: string): Promise<boolean> => {
      let removed = false;
      for (const [k, v] of this.discordRoleMapByKey) if (v.discordRoleId === discordRoleId) { this.discordRoleMapByKey.delete(k); removed = true; }
      return removed;
    },
  };

  tokens = {
    create: async (input: { userId: string; name: string; tokenHash: string; expiresAt?: string | null }): Promise<ApiTokenRow> => {
      const row: ApiTokenRow = {
        id: randomUUID(),
        userId: input.userId,
        name: input.name,
        tokenHash: input.tokenHash,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt ?? null,
      };
      this.tokensByHash.set(row.tokenHash, row);
      return row;
    },
    findByHash: async (tokenHash: string) => this.tokensByHash.get(tokenHash) ?? null,
    listByUser: async (userId: string): Promise<ApiTokenRow[]> =>
      [...this.tokensByHash.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    remove: async (id: string, userId: string): Promise<boolean> => {
      for (const [hash, t] of this.tokensByHash) {
        if (t.id === id && t.userId === userId) return this.tokensByHash.delete(hash);
      }
      return false;
    },
    removeAllForUser: async (userId: string): Promise<number> => {
      let n = 0;
      for (const [hash, t] of this.tokensByHash) if (t.userId === userId) { this.tokensByHash.delete(hash); n += 1; }
      return n;
    },
  };

  pushSubscriptions = {
    list: async (): Promise<PushSubscriptionRow[]> => [...this.pushByEndpoint.values()].map((d) => ({ ...d })),
    listByUser: async (userId: string): Promise<PushSubscriptionRow[]> =>
      [...this.pushByEndpoint.values()].filter((d) => d.userId === userId).map((d) => ({ ...d })),
    get: async (endpoint: string): Promise<PushSubscriptionRow | null> => {
      const d = this.pushByEndpoint.get(endpoint);
      return d ? { ...d } : null;
    },
    upsert: async (row: Omit<PushSubscriptionRow, "createdAt">): Promise<PushSubscriptionRow> => {
      const next = { ...row, createdAt: this.pushByEndpoint.get(row.endpoint)?.createdAt ?? new Date().toISOString() };
      this.pushByEndpoint.set(row.endpoint, next);
      return { ...next };
    },
    remove: async (endpoint: string): Promise<boolean> => this.pushByEndpoint.delete(endpoint),
  };

  // Callers get COPIES, never the stored object. Postgres can only ever return a fresh row per
  // query, and route code is written against that: it reads a server, writes an update, then
  // keeps using the first object as "how things were". With live references the update mutates
  // that object too — the game-switch route's audit really did log "was hllv" about a server
  // that had been hll two lines earlier, and skipped its cleanup because the "old" game had
  // already become the new one. Same lesson as copyEscalation in the seeding planner.
  private copyServer(row: ServerRow): ServerRow {
    // Internal rows keep `name` = the game's real name; the display resolution happens here, on
    // the way OUT, exactly as the Postgres row mapper does — see ServerRow.name.
    const nickname = row.nickname?.trim() || null;
    return { ...row, automation: { ...row.automation }, name: nickname ?? row.name, gameName: row.name, nickname, formerNames: [...(row.formerNames ?? [])] };
  }
  /** The Postgres trigger's rule (migration 102): a name being replaced joins the history. */
  private rememberNames(row: ServerRow, olds: (string | null | undefined)[]): void {
    const add = olds.map((n) => n?.trim() ?? "").filter(Boolean);
    if (!add.length) return;
    row.formerNames = [...new Set([...add, ...(row.formerNames ?? [])])].slice(0, 20);
  }
  private copyServerOrNull(row: ServerRow | null | undefined): ServerRow | null {
    return row ? this.copyServer(row) : null;
  }

  servers = {
    create: async (input: NewServer): Promise<ServerRow> => {
      const row: ServerRow = {
        id: randomUUID(),
        name: input.name,
        gameName: input.name,
        game: input.game ?? "hll",
        protocol: input.protocol ?? "binary-v2",
        host: input.host,
        port: input.port,
        password: input.password,
        engagementMode: input.engagementMode ?? "observe",
        automation: input.automation ?? {},
        headerMode: input.headerMode ?? "magic",
        gameVersion: null,
        timezone: null,
        crconBaseUrl: input.crconBaseUrl ?? null,
        streamerMode: false,
        publicSlug: null,
        publicName: null,
        nickname: null,
        publicPlayerIds: true, // matches the column default (migration 035)
        seedSlot: input.seedSlot ?? null,
        lastContactAt: null,
        lastError: null,
        lastErrorAt: null,
        retiredAt: null,
        formerNames: [],
        decommissionedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.serversById.set(row.id, row);
      return this.copyServer(row);
    },
    findById: async (id: string) => this.copyServerOrNull(this.serversById.get(id)),
    findByHostPort: async (host: string, port: number) =>
      this.copyServerOrNull([...this.serversById.values()].find((s) => s.host === host && s.port === port)),
    recordContact: async (id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> => {
      const row = this.serversById.get(id);
      if (!row) return;
      if (outcome.ok) {
        const since = row.lastContactAt ? Date.now() - Date.parse(row.lastContactAt) : Infinity;
        if (row.lastError === null && since < 60_000) return; // same throttle the SQL store applies
        row.lastContactAt = new Date().toISOString();
        row.lastError = null;
        row.lastErrorAt = null;
        return;
      }
      row.lastError = outcome.error.slice(0, 500);
      row.lastErrorAt = new Date().toISOString();
    },
    findBySeedSlot: async (slot: number) =>
      this.copyServerOrNull([...this.serversById.values()].find((s) => s.seedSlot === slot)),
    claimSeedSlot: async (id: string, slot: number): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      // A slot another server already holds is left where it is — see the Postgres note.
      if ([...this.serversById.values()].some((s) => s.seedSlot === slot && s.id !== id)) return null;
      row.seedSlot = slot;
      return this.copyServer(row);
    },
    list: async (opts?: { includeRetired?: boolean }) =>
      [...this.serversById.values()].filter((s) => opts?.includeRetired || s.retiredAt === null).map((s) => this.copyServer(s)),
    setRetired: async (id: string, retired: boolean): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.retiredAt = retired ? new Date().toISOString() : null;
      return this.copyServer(row);
    },
    setDecommissioned: async (id: string, decommissioned: boolean): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.decommissionedAt = decommissioned ? new Date().toISOString() : null;
      return this.copyServer(row);
    },
    remove: async (id: string): Promise<boolean> => {
      // Mirrors what the Postgres schema's ON DELETE CASCADE takes with the row. History tables
      // with no FK (events, sessions, careers) are the caller's purgeServerData job, as in SQL.
      if (!this.serversById.delete(id)) return false;
      const dropKeyed = (m: Map<string, unknown>) => { for (const k of [...m.keys()]) if (k === id || k.startsWith(`${id}|`)) m.delete(k); };
      for (const m of [this.vipsByKey, this.consoleAdminsByKey, this.crconBansByKey, this.seedProgress, this.layoutExpiriesByKey, this.mapPointPendingByServer] as Map<string, unknown>[]) dropKeyed(m);
      for (const m of [this.seedingConfigs, this.seedingStates, this.broadcastConfigs, this.welcomeConfigs, this.gameRewardConfigs, this.autoSettingsConfigs, this.mapVoteConfigs, this.mapVoteStates, this.discordRelayConfigs, this.adminCamConfigs] as Map<string, unknown>[]) m.delete(id);
      for (const [k, r] of this.rulesById) if (r.serverId === id) this.rulesById.delete(k);
      // The rule-status and VIP-cooldown records key the server in the middle or the end, so the
      // prefix sweep above never reaches them — a community-wide rule would keep a ghost status
      // (and its per-player cooldowns) for a server that no longer exists.
      for (const k of [...this.ruleStatus.keys()]) if (k.endsWith(`|${id}`)) this.ruleStatus.delete(k);
      for (const k of [...this.vipGrantAt.keys()]) if (k.includes(`|${id}|`)) this.vipGrantAt.delete(k);
      for (const [k, t] of this.playerTriggersById) if (t.serverId === id) this.playerTriggersById.delete(k);
      for (const [k, j] of this.crconJobsById) if (j.serverId === id) { this.crconJobsById.delete(k); this.crconJobKeys.delete(k); }
      const goneMatches = new Set([...this.matchesById.values()].filter((m) => m.serverId === id).map((m) => m.id));
      for (const mid of goneMatches) {
        this.matchesById.delete(mid);
        this.weaponRollupDone.delete(mid);
        this.crconPlayerStats.delete(mid);
        this.scoreSeriesByMatch.delete(mid);
      }
      for (const [k, s] of this.matchStatsByKey) if (goneMatches.has(s.matchId)) this.matchStatsByKey.delete(k);
      for (const [k, wk] of this.matchWeaponKills) if (goneMatches.has(wk.matchId)) this.matchWeaponKills.delete(k);
      for (const [k, r] of this.crconShortRounds) if (r.serverId === id) this.crconShortRounds.delete(k);
      this.rosterSnaps = this.rosterSnaps.filter((r) => r.serverId !== id);
      this.adminCamSessions = this.adminCamSessions.filter((s) => s.serverId !== id);
      return true;
    },
    setEngagementMode: async (id: string, mode: EngagementMode): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.engagementMode = mode;
      return this.copyServer(row);
    },
    updateConnection: async (id: string, patch: ServerConnectionPatch): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      // Only what was sent. An omitted password keeps the stored one — that is what lets the
      // editor open without the secret ever being handed back to the browser.
      if (patch.host !== undefined) row.host = patch.host;
      if (patch.port !== undefined) row.port = patch.port;
      if (patch.password !== undefined) row.password = patch.password;
      if (patch.protocol !== undefined) row.protocol = patch.protocol;
      if (patch.headerMode !== undefined) row.headerMode = patch.headerMode;
      if (patch.crconBaseUrl !== undefined) row.crconBaseUrl = patch.crconBaseUrl;
      return this.copyServer(row);
    },
    setStreamerMode: async (id: string, on: boolean): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.streamerMode = on;
      return this.copyServer(row);
    },
    setPublicProfile: async (id: string, profile: { publicSlug: string | null; publicName: string | null; publicPlayerIds: boolean }): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      // Same contract as Postgres's UNIQUE constraint: a taken slug is a thrown error, not a
      // silent overwrite — two servers answering one public address is corruption.
      if (profile.publicSlug !== null) {
        for (const other of this.serversById.values()) {
          if (other.id !== id && other.publicSlug === profile.publicSlug) throw new Error(`public slug "${profile.publicSlug}" is already taken`);
        }
      }
      this.rememberNames(row, [
        row.publicSlug !== profile.publicSlug ? row.publicSlug : null,
        row.publicName !== profile.publicName ? row.publicName : null,
      ]);
      row.publicSlug = profile.publicSlug;
      row.publicName = profile.publicName;
      row.publicPlayerIds = profile.publicPlayerIds;
      return this.copyServer(row);
    },
    setNickname: async (id: string, nickname: string | null): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      if (row.nickname !== nickname) this.rememberNames(row, [row.nickname]);
      row.nickname = nickname;
      return this.copyServer(row);
    },
    findBySlug: async (publicSlug: string): Promise<ServerRow | null> =>
      // Retired servers do not answer their public address — see the Postgres note.
      this.copyServerOrNull([...this.serversById.values()].find((s) => s.publicSlug !== null && s.publicSlug === publicSlug && s.retiredAt === null)),
    setAutomation: async (id: string, automation: ServerRow["automation"]): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.automation = automation ?? {};
      return this.copyServer(row);
    },
    updateName: async (id: string, name: string): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      if (row.name !== name) this.rememberNames(row, [row.name]);
      row.name = name;
      return this.copyServer(row);
    },
    setGame: async (id: string, game: string, protocol: RconProtocol): Promise<ServerRow | null> => {
      const row = this.serversById.get(id);
      if (!row) return null;
      row.game = game;
      row.protocol = protocol;
      return this.copyServer(row);
    },
  };

  grants = {
    listByUser: async (userId: string) => this.grantsByUser.get(userId) ?? [],
    userIdsWithGlobalCapability: async (capability: string, level: AccessLevel): Promise<string[]> =>
      [...this.grantsByUser.entries()]
        .filter(([, gs]) => gs.some((g) => g.capability === capability && g.scopeType === "global" && LEVEL_ORDER[g.level] >= LEVEL_ORDER[level]))
        .map(([uid]) => uid),
    create: async (input: Omit<GrantRow, "id">): Promise<GrantRow> => {
      const row: GrantRow = { id: randomUUID(), ...input };
      const list = this.grantsByUser.get(input.userId) ?? [];
      list.push(row);
      this.grantsByUser.set(input.userId, list);
      return row;
    },
    remove: async (id: string): Promise<boolean> => {
      for (const [userId, list] of this.grantsByUser) {
        const next = list.filter((g) => g.id !== id);
        if (next.length !== list.length) {
          this.grantsByUser.set(userId, next);
          return true;
        }
      }
      return false;
    },
  };

  userLimits = {
    get: async (userId: string) => ({ ...(this.limitsByUser.get(userId) ?? {}) }),
    replace: async (userId: string, limits: Record<string, number>) => {
      if (Object.keys(limits).length) this.limitsByUser.set(userId, { ...limits });
      else this.limitsByUser.delete(userId);
    },
  };

  roles = {
    list: async () => [...this.rolesById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get: async (id: string) => this.rolesById.get(id) ?? null,
    getMany: async (ids: string[]) =>
      [...new Set(ids.filter(Boolean))].map((id) => this.rolesById.get(id)).filter((r): r is RoleRow => r != null),
    findByName: async (name: string) =>
      [...this.rolesById.values()].find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null,
    create: async (input: NewRole): Promise<RoleRow> => {
      const now = new Date().toISOString();
      const row: RoleRow = {
        id: randomUUID(), name: input.name, description: input.description ?? null,
        grants: [...input.grants], limits: { ...input.limits },
        createdByName: input.createdByName ?? null, createdAt: now, updatedAt: now,
      };
      this.rolesById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: Partial<Omit<NewRole, "createdByName">>): Promise<RoleRow | null> => {
      const row = this.rolesById.get(id);
      if (!row) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.description !== undefined) row.description = patch.description ?? null;
      if (patch.grants !== undefined) row.grants = [...patch.grants];
      if (patch.limits !== undefined) row.limits = { ...patch.limits };
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string) => {
      if (!this.rolesById.delete(id)) return false;
      // A deleted role loses every assignment of it, at every scope.
      for (const m of this.rolesByUser.values()) for (const [k, a] of m) if (a.roleId === id) m.delete(k);
      return true;
    },
  };

  userRoles = {
    listByUser: async (userId: string): Promise<RoleAssignment[]> =>
      [...(this.rolesByUser.get(userId) ?? new Map()).values()].map((a) => ({ ...a })),
    listByUsers: async (userIds: string[]): Promise<Map<string, RoleAssignment[]>> => {
      const out = new Map<string, RoleAssignment[]>();
      for (const uid of new Set(userIds.filter(Boolean))) {
        const held = this.rolesByUser.get(uid);
        if (held?.size) out.set(uid, [...held.values()].map((a) => ({ ...a })));
      }
      return out;
    },
    // Holding the role anywhere counts as membership — the roles view is counting people.
    members: async (roleId: string) =>
      [...this.rolesByUser.entries()].filter(([, m]) => [...m.values()].some((a) => a.roleId === roleId)).map(([uid]) => uid),
    unscopedMembersOf: async (roleIds: string[]): Promise<string[]> => {
      const want = new Set(roleIds.filter(Boolean));
      if (!want.size) return [];
      return [...this.rolesByUser.entries()]
        .filter(([, m]) => [...m.values()].some((a) => a.scopeId === null && want.has(a.roleId)))
        .map(([uid]) => uid);
    },
    set: async (userId: string, assignments: RoleAssignment[]) => {
      if (!assignments.length) { this.rolesByUser.delete(userId); return; }
      // Keyed by role AND scope so the same role at two scopes survives, while an exact repeat
      // collapses — matching the unique index Postgres enforces.
      const m = new Map<string, RoleAssignment>();
      for (const a of assignments) m.set(`${a.roleId}|${a.scopeId ?? ""}`, { roleId: a.roleId, scopeId: a.scopeId });
      this.rolesByUser.set(userId, m);
    },
  };

  /** Record a name/clan-tag sighting: stamp firstSeen once, then bump lastSeen + seenCount. */
  private recordAlias(playerId: string, kind: "name" | "clan", value: string, ts: string): void {
    const v = value.trim();
    if (!v) return;
    const list = this.aliasesByPlayer.get(playerId) ?? [];
    const hit = list.find((a) => a.kind === kind && a.value === v);
    if (hit) {
      if (ts > hit.lastSeen) hit.lastSeen = ts;
      if (ts < hit.firstSeen) hit.firstSeen = ts;
      hit.seenCount += 1;
    } else {
      list.push({ playerId, kind, value: v, firstSeen: ts, lastSeen: ts, seenCount: 1 });
    }
    this.aliasesByPlayer.set(playerId, list);
  }

  /**
   * What can actually vouch for a player's last_seen: the newest session end, the newest event
   * naming them (either side of a kill), and their first_seen as the floor. Shared by the repair
   * and the drift report so the two can never disagree about what the evidence says.
   */
  private lastSeenEvidence(p: PlayerRow): { best: string; sessionEnd: string | null; event: string | null } {
    let sessionEnd: string | null = null;
    for (const s of this.sessionsByPlayer.get(p.id) ?? []) {
      if (s.disconnectedAt && (sessionEnd === null || s.disconnectedAt > sessionEnd)) sessionEnd = s.disconnectedAt;
    }
    let event: string | null = null;
    for (const e of this.evts) {
      if ((e.actorPlayerId === p.id || e.victimPlayerId === p.id) && (event === null || e.ts > event)) event = e.ts;
    }
    let best = p.firstSeen;
    if (sessionEnd && sessionEnd > best) best = sessionEnd;
    if (event && event > best) best = event;
    return { best, sessionEnd, event };
  }

  /**
   * Everything matching the directory's filters, enriched — shared by `directory` and its count.
   *
   * `serverIds` changes the question: scoped, only players with a row on one of those servers,
   * carrying their figures there; unscoped, everyone, with careers summed across every server.
   * Mirrors `directoryFrom` in the Postgres store.
   */
  private directoryMatches(f: PlayerDirectoryFilters): PlayerDirectoryRow[] {
    const needle = f.q?.trim().toLowerCase();
    const now = new Date().toISOString();
    const inScope = (serverId: string | null) => !f.serverIds || (serverId != null && f.serverIds.includes(serverId));
    // A live VIP grant, from the grants table — the same source the profile's VIP panel uses, and
    // scoped to the chosen servers. There is no second, manual VIP marker any more: one fact, one source.
    // Not a retired server's, which the profile leaves out too: kept for its return, not held now.
    const hasVip = (platformId: string) =>
      [...this.vipsByKey.values()].some((v) =>
        v.playerId === platformId && inScope(v.serverId) && (v.expiration == null || v.expiration > now)
        && !this.serversById.get(v.serverId)?.retiredAt);
    const scopedRows = (playerId: string) => this.statsRowsFor(playerId).filter((s) => inScope(s.serverId));
    return [...this.playersById.values()]
      .filter((p) => !f.serverIds || scopedRows(p.id).length > 0)
      .map((p): PlayerDirectoryRow => {
        const st = this.foldStats(scopedRows(p.id));
        const fl = this.flagsByPlayer.get(p.id);
        return {
          ...p,
          kills: st?.kills ?? 0, deaths: st?.deaths ?? 0, teamkills: st?.teamkills ?? 0,
          visits: st?.visits ?? 0, playtimeSec: st?.playtimeSec ?? 0,
          watchlist: fl?.watchlist ?? false, vip: hasVip(p.platformId),
          // Filled in by `directory` once it knows which column it sorted by.
          sortKey: null,
        };
      })
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.platformId.toLowerCase().includes(needle) || this.linkedIdMatches(p.id, needle))
      .filter((p) => {
        if (!f.platform) return true;
        const fam = platformFamilyTokens(f.platform);
        return fam ? fam.includes(normalizePlatformToken(p.platform)) : p.platform === f.platform;
      })
      .filter((p) => !f.game || p.game === f.game)
      .filter((p) => !f.seenFrom || p.lastSeen >= f.seenFrom)
      .filter((p) => !f.seenTill || p.lastSeen <= f.seenTill)
      .filter((p) => !f.watchedOnly || p.watchlist)
      .filter((p) => !f.vipOnly || p.vip)
      .filter((p) => !f.clanTags || (this.aliasesByPlayer.get(p.id) ?? []).some((a) => a.kind === "clan" && f.clanTags!.includes(a.value)))
      .filter((p) => !f.permaBannedOnly || [...this.playerBansById.values()].some((b) => b.playerId === p.platformId && b.kind === "perma" && b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now)));
  }

  players = {
    upsert: async (input: SeenPlayer): Promise<PlayerRow> => {
      // Identity is platform_id ALONE (mirrors migration 041) — the platform string is display
      // metadata, and a real platform replaces an inferred "other"/"unknown" placeholder.
      const key = input.platformId;
      const now = input.ts ?? new Date().toISOString();
      const existing = this.playersByPlatform.get(key);
      // `game` is set on creation only: an account belongs to the game whose server reported it and
      // cannot move to another, so a later sighting never rewrites it.
      const row = existing ?? { id: randomUUID(), game: input.game, platform: input.platform, platformId: input.platformId, name: input.name, level: input.level ?? null, firstSeen: now, lastSeen: now };
      if (existing) {
        existing.name = input.name || existing.name;
        if (now > existing.lastSeen) existing.lastSeen = now;
        // A historical sighting (a CRCON import) may predate the row: first seen is the EARLIEST
        // sighting, wherever it came from, or a 2021 regular reads as joining install day.
        if (now < existing.firstSeen) existing.firstSeen = now;
        if (["other", "unknown"].includes(existing.platform) && !["other", "unknown"].includes(input.platform)) existing.platform = input.platform;
        // A sighting that could not read the level leaves the stored one alone — same rule as the
        // SQL's COALESCE: not seeing a level is not evidence of not having one.
        if (input.level !== undefined) existing.level = input.level;
      } else {
        this.playersById.set(row.id, row);
        this.playersByPlatform.set(key, row);
      }
      this.recordAlias(row.id, "name", input.name, now);
      if (input.clanTag !== undefined) this.recordAlias(row.id, "clan", input.clanTag, now);
      return row;
    },
    upsertMany: async (inputs: SeenPlayer[]): Promise<PlayerRow[]> => {
      // Mirrors the SQL version's two dedupes: one sighting per distinct name/clan a player was
      // seen under in this batch (so a rename mid-read still records both), and one player row
      // per platform id with the last read winning. Doing it by replaying `upsert` over the
      // distinct sightings gets both for free.
      const distinct = new Map<string, SeenPlayer>();
      for (const i of inputs) {
        const platformId = String(i.platformId ?? "").trim();
        if (!platformId) continue;                       // a blank id is not a player
        distinct.set(`${platformId}\u0000${i.name}\u0000${i.clanTag ?? ""}`, { ...i, platformId });
      }
      const byPlatform = new Map<string, PlayerRow>();
      for (const input of distinct.values()) byPlatform.set(input.platformId, await this.players.upsert(input));
      return [...byPlatform.values()];
    },
    settleLastSeenFromEvidence: async (): Promise<number> => {
      // Mirrors the SQL store: only ever lowers, only when the stored value postdates everything.
      let lowered = 0;
      for (const p of this.playersById.values()) {
        const { best } = this.lastSeenEvidence(p);
        if (p.lastSeen > best) { p.lastSeen = best; lowered += 1; }
      }
      return lowered;
    },
    lastSeenDrift: async (limit = 20): Promise<LastSeenDrift> => {
      const drifted = [...this.playersById.values()]
        .map((p) => ({ p, ev: this.lastSeenEvidence(p) }))
        .filter(({ p, ev }) => p.lastSeen > ev.best);
      const sample = drifted
        .sort((a, b) => (Date.parse(b.p.lastSeen) - Date.parse(b.ev.best)) - (Date.parse(a.p.lastSeen) - Date.parse(a.ev.best)))
        .slice(0, Math.max(1, Math.min(200, limit)))
        .map(({ p, ev }) => ({
          id: p.id, name: p.name, platformId: p.platformId, lastSeen: p.lastSeen,
          best: ev.best, firstSeen: p.firstSeen, lastSessionEnd: ev.sessionEnd, lastEvent: ev.event,
        }));
      return { total: drifted.length, sample };
    },
    findById: async (id: string) => this.playersById.get(id) ?? null,
    findByIds: async (ids: string[]): Promise<PlayerRow[]> =>
      [...new Set(ids)].map((id) => this.playersById.get(id)).filter((p): p is PlayerRow => p != null),
    findByAnyIds: async (ids: string[]): Promise<PlayerRow[]> => {
      const want = new Set(ids.filter(Boolean));
      return [...this.playersById.values()].filter((p) => want.has(p.id) || want.has(p.platformId));
    },
    findByPlatformId: async (platformId: string) => [...this.playersById.values()].find((p) => p.platformId === platformId) ?? null,
    findByPlatformIds: async (platformIds: string[]) => {
      const want = new Set(platformIds);
      return [...this.playersById.values()].filter((p) => want.has(p.platformId)).map((p) => ({ ...p }));
    },
    list: async (limit = 100) => [...this.playersById.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.platformId.localeCompare(b.platformId)).slice(0, limit),
    search: async (q: string, limit = 100) => {
      const needle = q.toLowerCase();
      // Linked identities count as the player's ids — mirrors the Postgres search, same reason.
      return [...this.playersById.values()]
        .filter((p) => p.name.toLowerCase().includes(needle) || p.platformId.toLowerCase().includes(needle) || this.linkedIdMatches(p.id, needle))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.platformId.localeCompare(b.platformId))
        .slice(0, limit);
    },
    directory: async (f: PlayerDirectoryFilters): Promise<PlayerDirectoryRow[]> => {
      // Each comparator is written ASCENDING and the direction is applied once below, so the two
      // stores cannot disagree about what "descending by name" means.
      const sorters: Record<string, (a: PlayerDirectoryRow, b: PlayerDirectoryRow) => number> = {
        lastSeen: (a, b) => a.lastSeen.localeCompare(b.lastSeen),
        firstSeen: (a, b) => a.firstSeen.localeCompare(b.firstSeen),
        name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        platform: (a, b) => a.platform.toLowerCase().localeCompare(b.platform.toLowerCase()),
        kills: (a, b) => a.kills - b.kills,
        teamkills: (a, b) => a.teamkills - b.teamkills,
        playtime: (a, b) => a.playtimeSec - b.playtimeSec,
        visits: (a, b) => a.visits - b.visits,
      };
      // The value each row is sorted BY, so the caller can build the next cursor from it without
      // re-deriving an expression the store owns.
      const keyOf: Record<string, (r: PlayerDirectoryRow) => string | number | null> = {
        lastSeen: (r) => r.lastSeen, firstSeen: (r) => r.firstSeen,
        name: (r) => r.name?.toLowerCase() ?? null, platform: (r) => r.platform.toLowerCase(),
        kills: (r) => r.kills, teamkills: (r) => r.teamkills,
        playtime: (r) => r.playtimeSec, visits: (r) => r.visits,
      };
      const sortId = f.sort ?? "lastSeen";
      const key = keyOf[sortId] ?? keyOf.lastSeen!;
      const mul = f.sortDir === "asc" ? 1 : -1;
      const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
      // Searching ranks by how well the NAME matches before anything else — exact, starts-with,
      // contains, id-only — exactly as the SQL store does, and for the same reason: the player
      // literally named what was typed must top the list. Skipped under a cursor (see the SQL).
      const needle = f.q?.trim().toLowerCase();
      const rankOf = (r: PlayerDirectoryRow): number => {
        if (!needle) return 0;
        const n = r.name.toLowerCase();
        if (n === needle) return 0;
        const at = n.indexOf(needle);
        return at === 0 ? 1 : at > 0 ? 2 : 3;
      };
      const ranked = needle && !f.after;
      const ordered = this.directoryMatches(f)
        // Ties broken by id for the same reason the SQL does it: without a total order, paging can
        // show one row twice and never show another.
        .sort((a, b) => (ranked ? rankOf(a) - rankOf(b) : 0) || (sorters[sortId] ?? sorters.lastSeen!)(a, b) * mul || a.id.localeCompare(b.id))
        .map((r) => ({ ...r, sortKey: key(r) }));

      // Keyset when a cursor is given — the same rule as the SQL: everything strictly after that
      // position in this ordering. Offset only when there is no cursor.
      if (f.after) {
        const at = ordered.findIndex((r) => r.id === f.after!.id);
        if (at >= 0) return ordered.slice(at + 1, at + 1 + limit);
        // The anchor row is gone (merged, trimmed). Fall back to comparing the value, which still
        // lands the reader in the right neighbourhood rather than back at the top.
        const cmp = (v: string | number | null) => {
          if (v === null || f.after!.value === null) return v === null ? 1 : -1;
          return typeof v === "number" ? (v - Number(f.after!.value)) * mul : String(v).localeCompare(String(f.after!.value)) * mul;
        };
        return ordered.filter((r) => cmp(r.sortKey) > 0).slice(0, limit);
      }
      const from = Math.max(f.offset ?? 0, 0);
      return ordered.slice(from, from + limit);
    },
    // The count is the same match set without the page window — one matcher, so a total can never
    // describe a different set than the rows do.
    directoryCount: async (f: PlayerDirectoryFilters): Promise<number> => this.directoryMatches(f).length,
    count: async (): Promise<number> => this.playersById.size,
  };

  /** Whether a clan read's scope covers this player: their game, and a career row on its servers. */
  private inClanScope(p: PlayerRow, s: ClanScope): boolean {
    if (s.game && p.game !== s.game) return false;
    return !s.serverIds || this.statsRowsFor(p.id).some((r) => r.serverId !== null && s.serverIds!.includes(r.serverId));
  }

  /** A player's clan rows and the tag they wear now (same rule as the Postgres store's `cur`). */
  private clanRowsOf(p: PlayerRow): { clans: PlayerAliasRow[]; current: string | null } {
    const clans = (this.aliasesByPlayer.get(p.id) ?? []).filter((a) => a.kind === "clan");
    const newest = clans.reduce<PlayerAliasRow | null>((best, a) => (!best || Date.parse(a.lastSeen) > Date.parse(best.lastSeen) ? a : best), null);
    const current = newest && Date.parse(newest.lastSeen) >= Date.parse(p.lastSeen) - CLAN_CURRENT_GRACE_SEC * 1000 ? newest.value : null;
    return { clans, current };
  }

  clanTags = {
    tags: async (): Promise<string[]> => {
      const out = new Set<string>();
      for (const list of this.aliasesByPlayer.values()) for (const a of list) if (a.kind === "clan") out.add(a.value);
      return [...out];
    },
    spellings: async (opts: ClanScope = {}): Promise<ClanSpellingRow[]> => {
      const out = new Map<string, ClanSpellingRow>();
      for (const p of this.playersById.values()) {
        if (!this.inClanScope(p, opts)) continue;
        const { clans, current } = this.clanRowsOf(p);
        for (const a of clans) {
          const row = out.get(a.value) ?? { tag: a.value, ever: 0, now: 0, lastSeen: a.lastSeen };
          row.ever += 1;
          if (current === a.value) row.now += 1;
          if (Date.parse(a.lastSeen) > Date.parse(row.lastSeen)) row.lastSeen = a.lastSeen;
          out.set(a.value, row);
        }
      }
      return [...out.values()];
    },
    groupStats: async (groups: { key: string; tags: string[] }[], opts: ClanScope = {}): Promise<ClanGroupStatsRow[]> => {
      const keyOf = new Map<string, string>();
      for (const g of groups) for (const t of g.tags) keyOf.set(t, g.key);
      const acc = new Map<string, { ever: Set<string>; now: Set<string>; lastSeen: string | null }>();
      for (const p of this.playersById.values()) {
        if (!this.inClanScope(p, opts)) continue;
        const { clans, current } = this.clanRowsOf(p);
        for (const a of clans) {
          const key = keyOf.get(a.value);
          if (key === undefined) continue;
          const g = acc.get(key) ?? { ever: new Set<string>(), now: new Set<string>(), lastSeen: null };
          g.ever.add(p.id);
          if (current === a.value) g.now.add(p.id);
          if (!g.lastSeen || Date.parse(a.lastSeen) > Date.parse(g.lastSeen)) g.lastSeen = a.lastSeen;
          acc.set(key, g);
        }
      }
      return [...acc].map(([key, g]) => ({ key, ever: g.ever.size, now: g.now.size, lastSeen: g.lastSeen }));
    },
    members: async (q: ClanMembersQuery): Promise<{ rows: ClanMemberRow[]; total: number }> => {
      const tags = new Set(q.tags.map((t) => t.trim()).filter(Boolean));
      if (!tags.size) return { rows: [], total: 0 };
      const all: ClanMemberRow[] = [];
      for (const p of this.playersById.values()) {
        if (!this.inClanScope(p, q)) continue;
        if (q.seenFrom && Date.parse(p.lastSeen) < Date.parse(q.seenFrom)) continue;
        const { clans, current } = this.clanRowsOf(p);
        const worn = clans.filter((a) => tags.has(a.value));
        if (!worn.length) continue;
        const newest = worn.reduce((best, a) => (Date.parse(a.lastSeen) > Date.parse(best.lastSeen) ? a : best));
        const first = worn.reduce((best, a) => (Date.parse(a.firstSeen) < Date.parse(best.firstSeen) ? a : best));
        const wearingNow = current !== null && tags.has(current);
        if (q.status === "now" && !wearingNow) continue;
        if (q.status === "former" && wearingNow) continue;
        all.push({ player: { ...p }, tag: newest.value, firstSeen: first.firstSeen, lastSeen: newest.lastSeen, wearingNow, currentTag: current });
      }
      all.sort((a, b) => Number(b.wearingNow) - Number(a.wearingNow) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || (a.player.id < b.player.id ? -1 : 1));
      const offset = Math.max(q.offset ?? 0, 0);
      const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
      return { rows: all.slice(offset, offset + limit), total: all.length };
    },
  };

  playerAliases = {
    list: async (playerId: string): Promise<PlayerAliasRow[]> =>
      (this.aliasesByPlayer.get(playerId) ?? []).slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    record: async (playerId: string, kind: "name" | "clan", value: string, ts: string): Promise<void> => {
      this.recordAlias(playerId, kind, value, ts);
    },
    recordMany: async (rows: { playerId: string; kind: "name" | "clan"; value: string; ts: string }[]): Promise<void> => {
      // The loop IS the batch here, so the widening and counting rules can only be the same ones.
      for (const r of rows) this.recordAlias(r.playerId, r.kind, r.value, r.ts);
    },
  };

  externalLinks = {
    distinctExternalIds: async (provider: string): Promise<string[]> =>
      [...new Set([...this.linksByKey.values()].filter((l) => l.provider === provider).map((l) => l.externalId))].sort(),
    list: async (playerId: string): Promise<ExternalLinkRow[]> =>
      [...this.linksByKey.values()].filter((l) => l.playerId === playerId).sort((a, b) => a.provider.localeCompare(b.provider)),
    set: async (playerId: string, provider: string, externalId: string | null, byName: string | null = null): Promise<void> => {
      const key = `${playerId}|${provider}`;
      const id = externalId?.trim();
      if (!id) { this.linksByKey.delete(key); return; }
      this.linksByKey.set(key, { playerId, provider, externalId: id, createdByName: byName, createdAt: new Date().toISOString() });
    },
    findPlayer: async (provider: string, externalId: string): Promise<PlayerRow | null> => {
      const hit = [...this.linksByKey.values()].find((l) => l.provider === provider && l.externalId === externalId);
      return hit ? this.playersById.get(hit.playerId) ?? null : null;
    },
    findPlayers: async (provider: string, externalId: string): Promise<PlayerRow[]> =>
      [...this.linksByKey.values()]
        .filter((l) => l.provider === provider && l.externalId === externalId)
        .map((l) => this.playersById.get(l.playerId))
        .filter((p): p is PlayerRow => !!p)
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    linkedAmong: async (playerIds: string[], provider: string): Promise<Set<string>> => {
      const want = new Set(playerIds);
      return new Set([...this.linksByKey.values()].filter((l) => l.provider === provider && want.has(l.playerId)).map((l) => l.playerId));
    },
    findPlayersByExternalId: async (externalId: string): Promise<PlayerRow[]> => {
      const ids = new Set([...this.linksByKey.values()].filter((l) => l.externalId === externalId).map((l) => l.playerId));
      return [...ids]
        .map((id) => this.playersById.get(id))
        .filter((p): p is PlayerRow => !!p)
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    },
  };

  /** Does any of this player's linked identities contain the needle? (players.search / directory q) */
  private linkedIdMatches(playerId: string, needle: string): boolean {
    for (const l of this.linksByKey.values()) {
      if (l.playerId === playerId && l.externalId.toLowerCase().includes(needle)) return true;
    }
    return false;
  }

  playerTags = {
    list: async (playerId: string): Promise<PlayerTagRow[]> =>
      (this.tagsByPlayer.get(playerId) ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    labelsByPlatformIds: async (platformIds: string[]): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>();
      const want = new Set(platformIds.filter(Boolean));
      if (!want.size) return out;
      // playersByPlatform is the same index the postgres query hits via players.platform_id.
      for (const platformId of want) {
        const player = this.playersByPlatform.get(platformId);
        if (!player) continue;
        const tags = (this.tagsByPlayer.get(player.id) ?? []).slice().sort((x, y) => x.createdAt.localeCompare(y.createdAt));
        if (tags.length) out.set(platformId, tags.map((t) => t.label));
      }
      return out;
    },
    add: async (input: NewPlayerTag): Promise<PlayerTagRow> => {
      const row: PlayerTagRow = { id: randomUUID(), playerId: input.playerId, label: input.label, note: input.note ?? null, createdByName: input.createdByName, createdAt: new Date().toISOString() };
      const list = this.tagsByPlayer.get(input.playerId) ?? [];
      list.push(row);
      this.tagsByPlayer.set(input.playerId, list);
      return row;
    },
    remove: async (id: string): Promise<PlayerTagRow | null> => {
      for (const [pid, list] of this.tagsByPlayer) {
        const i = list.findIndex((t) => t.id === id);
        if (i >= 0) { const [row] = list.splice(i, 1); this.tagsByPlayer.set(pid, list); return row ?? null; }
      }
      return null;
    },
  };

  playerNotes = {
    list: async (playerId: string, limit = 100): Promise<PlayerNoteRow[]> =>
      this.notesByPlayer.get(playerId)?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit) ?? [],
    create: async (input: NewPlayerNote): Promise<PlayerNoteRow> => {
      const row: PlayerNoteRow = {
        id: randomUUID(),
        playerId: input.playerId,
        authorUserId: input.authorUserId ?? null,
        authorName: input.authorName,
        body: input.body,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      const list = this.notesByPlayer.get(input.playerId) ?? [];
      list.push(row);
      this.notesByPlayer.set(input.playerId, list);
      return row;
    },
    backdate: async (id: string, createdAt: string): Promise<void> => {
      for (const list of this.notesByPlayer.values()) {
        const row = list.find((n) => n.id === id);
        if (row) { if (createdAt < row.createdAt) row.createdAt = createdAt; return; }
      }
    },
  };

  private playerIpsByKey = new Map<string, PlayerIpRow>(); // key: `${playerId}|${ip}`

  playerIps = {
    record: async (playerId: string, ip: string, ts: string, source: string): Promise<void> => {
      const key = `${playerId}|${ip}`;
      const row = this.playerIpsByKey.get(key);
      if (!row) { this.playerIpsByKey.set(key, { playerId, ip, firstSeen: ts, lastSeen: ts, seenCount: 1, source }); return; }
      if (ts < row.firstSeen) row.firstSeen = ts;
      if (ts > row.lastSeen) row.lastSeen = ts;
      row.seenCount += 1;
    },
    list: async (playerId: string): Promise<PlayerIpRow[]> =>
      [...this.playerIpsByKey.values()].filter((r) => r.playerId === playerId).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    byIp: async (ip: string): Promise<PlayerIpRow[]> =>
      [...this.playerIpsByKey.values()].filter((r) => r.ip === ip).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    byIps: async (ips: string[]): Promise<PlayerIpRow[]> => {
      const want = new Set(ips);
      return [...this.playerIpsByKey.values()].filter((r) => want.has(r.ip)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    },
  };

  playerFlags = {
    get: async (playerId: string): Promise<PlayerFlagsRow | null> => this.flagsByPlayer.get(playerId) ?? null,
    set: async (playerId: string, patch: PlayerFlagsPatch, by: { userId: string | null; name: string }): Promise<PlayerFlagsRow> => {
      const cur = this.flagsByPlayer.get(playerId)
        ?? { playerId, watchlist: false, vip: false, updatedByName: null, updatedAt: null, watchReason: null, watchBy: null, watchAt: null };
      // Same provenance contract as the Postgres store: unwatch clears the CURRENT row (the
      // permanent history below keeps every spell); provided values overwrite; a fresh watch-on
      // defaults by/at to the acting user and now; everything else is kept.
      let { watchReason, watchBy, watchAt } = cur;
      if (patch.watchlist === false) {
        watchReason = null; watchBy = null; watchAt = null;
      } else {
        const arming = patch.watchlist === true && !cur.watchlist;
        if (patch.watchReason != null) watchReason = patch.watchReason;
        if (patch.watchBy != null) watchBy = patch.watchBy; else if (arming) watchBy = by.name;
        if (patch.watchAt != null) watchAt = patch.watchAt; else if (arming) watchAt = new Date().toISOString();
      }
      const row: PlayerFlagsRow = {
        playerId,
        watchlist: patch.watchlist ?? cur.watchlist,
        vip: patch.vip ?? cur.vip,
        updatedByName: by.name,
        updatedAt: new Date().toISOString(),
        watchReason, watchBy, watchAt,
      };
      this.flagsByPlayer.set(playerId, row);
      // Permanent history, mirroring the Postgres store: arming opens a spell, unwatching closes
      // the open one, re-imports syncing provenance update the open row in place.
      if (row.watchlist && !cur.watchlist) {
        this.watchHistoryRows.push({ id: randomUUID(), playerId, reason: watchReason, watchedBy: watchBy, watchedAt: watchAt ?? new Date().toISOString(), removedBy: null, removedAt: null });
      } else if (!row.watchlist && cur.watchlist) {
        for (const h of this.watchHistoryRows) {
          if (h.playerId === playerId && h.removedAt === null) { h.removedBy = by.name; h.removedAt = new Date().toISOString(); }
        }
      } else if (row.watchlist && cur.watchlist && (patch.watchReason != null || patch.watchBy != null || patch.watchAt != null)) {
        for (const h of this.watchHistoryRows) {
          if (h.playerId === playerId && h.removedAt === null) { h.reason = watchReason; h.watchedBy = watchBy; h.watchedAt = watchAt ?? h.watchedAt; }
        }
      }
      return row;
    },
    listWatched: async (): Promise<PlayerFlagsRow[]> => [...this.flagsByPlayer.values()].filter((f) => f.watchlist),
    watchHistory: async (playerId: string): Promise<WatchHistoryRow[]> =>
      // Same order as the Postgres store: newest first, id as the tie-breaker.
      this.watchHistoryRows.filter((h) => h.playerId === playerId)
        .sort((a, b) => b.watchedAt.localeCompare(a.watchedAt) || a.id.localeCompare(b.id))
        .map((h) => ({ ...h })),
  };

  private watchReasonRows: WatchReasonRow[] = []; // every reason ever, closed rather than deleted

  /** Same definition as the Postgres store's WATCH_ACTIVE fragment. */
  private static watchReasonActive(r: WatchReasonRow): boolean {
    return r.removedAt === null && (r.expiresAt === null || Date.parse(r.expiresAt) > Date.now());
  }

  watchReasons = {
    list: async (playerId: string): Promise<WatchReasonRow[]> =>
      this.watchReasonRows.filter((r) => r.playerId === playerId)
        .sort((a, b) =>
          Number(InMemoryRepository.watchReasonActive(b)) - Number(InMemoryRepository.watchReasonActive(a))
          || b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id))
        .map((r) => ({ ...r, edits: r.edits.map((e) => ({ ...e })) })),
    listActiveByPlayers: async (playerIds: string[]): Promise<Map<string, WatchReasonRow[]>> => {
      const want = new Set(playerIds);
      const out = new Map<string, WatchReasonRow[]>();
      const active = this.watchReasonRows
        .filter((r) => want.has(r.playerId) && InMemoryRepository.watchReasonActive(r))
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
      for (const r of active) {
        const arr = out.get(r.playerId) ?? [];
        arr.push({ ...r, edits: r.edits.map((e) => ({ ...e })) });
        out.set(r.playerId, arr);
      }
      return out;
    },
    get: async (id: string): Promise<WatchReasonRow | null> => {
      const r = this.watchReasonRows.find((x) => x.id === id);
      return r ? { ...r, edits: r.edits.map((e) => ({ ...e })) } : null;
    },
    add: async (input: { playerId: string; reason: string; addedBy: string | null; addedByUserId?: string | null; expiresAt?: string | null; addedAt?: string }): Promise<WatchReasonRow> => {
      const row: WatchReasonRow = {
        id: randomUUID(), playerId: input.playerId, reason: input.reason,
        addedBy: input.addedBy, addedByUserId: input.addedByUserId ?? null,
        addedAt: input.addedAt ?? new Date().toISOString(),
        expiresAt: input.expiresAt ?? null, removedBy: null, removedAt: null, edits: [],
      };
      this.watchReasonRows.push(row);
      return { ...row };
    },
    edit: async (id: string, patch: { reason?: string; expiresAt?: string | null }, by: string | null): Promise<WatchReasonRow | null> => {
      const row = this.watchReasonRows.find((x) => x.id === id && x.removedAt === null);
      if (!row) return null;
      // The previous version is archived FIRST — a closed reason cannot be rewritten, and an
      // open one never forgets what it used to say.
      row.edits.push({ reason: row.reason, expiresAt: row.expiresAt, editedBy: by, editedAt: new Date().toISOString() });
      if (patch.reason !== undefined) row.reason = patch.reason;
      if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
      return { ...row, edits: row.edits.map((e) => ({ ...e })) };
    },
    remove: async (id: string, by: string | null): Promise<WatchReasonRow | null> => {
      const row = this.watchReasonRows.find((x) => x.id === id && x.removedAt === null);
      if (!row) return null;
      row.removedBy = by;
      row.removedAt = new Date().toISOString();
      return { ...row, edits: row.edits.map((e) => ({ ...e })) };
    },
    removeAll: async (playerId: string, by: string | null): Promise<number> => {
      let n = 0;
      for (const row of this.watchReasonRows) {
        if (row.playerId !== playerId || row.removedAt !== null) continue;
        row.removedBy = by;
        row.removedAt = new Date().toISOString();
        n++;
      }
      return n;
    },
    lapsedWatchers: async (): Promise<string[]> =>
      [...this.flagsByPlayer.values()]
        .filter((f) => f.watchlist && !this.watchReasonRows.some((r) => r.playerId === f.playerId && InMemoryRepository.watchReasonActive(r)))
        .map((f) => f.playerId),
  };

  private approvalReqs = new Map<string, ApprovalRequestRow>();

  approvals = {
    create: async (input: { requesterUserId: string; requesterName: string; note?: string | null; status?: "draft" | "open" }): Promise<ApprovalRequestRow> => {
      const now = new Date().toISOString();
      const row: ApprovalRequestRow = {
        id: randomUUID(), requesterUserId: input.requesterUserId, requesterName: input.requesterName,
        status: input.status ?? "draft", note: input.note ?? null,
        createdAt: now, submittedAt: input.status === "open" ? now : null, expiresAt: null, resolvedAt: null, updatedAt: now,
        parkedAt: null,
        lines: [],
      };
      this.approvalReqs.set(row.id, row);
      return structuredClone(row);
    },
    get: async (id: string): Promise<ApprovalRequestRow | null> => {
      const r = this.approvalReqs.get(id);
      return r ? structuredClone(r) : null;
    },
    findDraft: async (requesterUserId: string): Promise<ApprovalRequestRow | null> => {
      const drafts = [...this.approvalReqs.values()]
        .filter((r) => r.requesterUserId === requesterUserId && r.status === "draft")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return drafts[0] ? structuredClone(drafts[0]) : null;
    },
    list: async (q: { status?: ApprovalRequestStatus[]; requesterUserId?: string; limit?: number } = {}): Promise<ApprovalRequestRow[]> => {
      return [...this.approvalReqs.values()]
        .filter((r) => (!q.status?.length || q.status.includes(r.status)) && (!q.requesterUserId || r.requesterUserId === q.requesterUserId))
        .sort((a, b) => (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt))
        .slice(0, Math.min(q.limit ?? 200, 500))
        .map((r) => structuredClone(r));
    },
    addLine: async (requestId: string, input: NewApprovalLine): Promise<ApprovalLineRow | null> => {
      const r = this.approvalReqs.get(requestId);
      if (!r || (r.status !== "draft" && r.status !== "open")) return null;
      const line: ApprovalLineRow = {
        id: randomUUID(), requestId, seq: input.seq ?? 0, serverId: input.serverId ?? null,
        capability: input.capability, kind: input.kind, payload: structuredClone(input.payload),
        playerId: input.playerId ?? null, playerName: input.playerName ?? null,
        state: "pending", decidedByUserId: null, decidedByName: null, decidedAt: null,
        denyReason: null, modified: null, appliedAt: null, applyError: null,
        createdAt: new Date().toISOString(),
      };
      r.lines.push(line);
      r.updatedAt = new Date().toISOString();
      return structuredClone(line);
    },
    removeLine: async (requestId: string, lineId: string): Promise<boolean> => {
      const r = this.approvalReqs.get(requestId);
      if (!r || r.status !== "draft") return false;
      const before = r.lines.length;
      r.lines = r.lines.filter((l) => l.id !== lineId);
      r.updatedAt = new Date().toISOString(); // activity — the stale-draft sweep reads this
      return r.lines.length < before;
    },
    submit: async (id: string, expiresAt: string): Promise<ApprovalRequestRow | null> => {
      const r = this.approvalReqs.get(id);
      if (!r || r.status !== "draft") return null;
      r.status = "open"; r.submittedAt = new Date().toISOString(); r.expiresAt = expiresAt; r.updatedAt = r.submittedAt;
      return structuredClone(r);
    },
    discardDraft: async (id: string): Promise<boolean> => {
      const r = this.approvalReqs.get(id);
      if (!r || r.status !== "draft") return false;
      return this.approvalReqs.delete(id);
    },
    parkDraft: async (requesterUserId: string, parked: boolean): Promise<ApprovalRequestRow | null> => {
      const r = [...this.approvalReqs.values()].find((x) => x.requesterUserId === requesterUserId && x.status === "draft");
      if (!r) return null;
      const now = new Date().toISOString();
      r.parkedAt = parked ? now : null;
      r.updatedAt = now;
      return structuredClone(r);
    },
    discardStaleDrafts: async (cutoffIso: string): Promise<ApprovalRequestRow[]> => {
      const out: ApprovalRequestRow[] = [];
      for (const r of [...this.approvalReqs.values()]) {
        if (r.status !== "draft" || (r.updatedAt ?? r.createdAt) >= cutoffIso) continue;
        this.approvalReqs.delete(r.id);
        out.push(structuredClone(r));
      }
      return out;
    },
    withdraw: async (id: string): Promise<ApprovalRequestRow | null> => {
      const r = this.approvalReqs.get(id);
      if (!r || r.status !== "open") return null;
      r.status = "withdrawn"; r.resolvedAt = new Date().toISOString(); r.updatedAt = r.resolvedAt;
      for (const l of r.lines) if (l.state === "pending") l.state = "voided";
      return structuredClone(r);
    },
    decideLine: async (lineId: string, d: { state: "approved" | "denied"; byUserId: string; byName: string; denyReason?: string | null; modified?: Record<string, { requested: number; granted: number }> | null }): Promise<ApprovalLineRow | null> => {
      for (const r of this.approvalReqs.values()) {
        const l = r.lines.find((x) => x.id === lineId);
        if (!l) continue;
        // Same conditional transition as the Postgres store: only a pending line of an OPEN
        // request moves, so the second of two simultaneous clicks gets null, never a re-execute.
        if (l.state !== "pending" || r.status !== "open") return null;
        l.state = d.state; l.decidedByUserId = d.byUserId; l.decidedByName = d.byName;
        l.decidedAt = new Date().toISOString(); l.denyReason = d.denyReason ?? null;
        l.modified = d.modified ? structuredClone(d.modified) : null;
        return structuredClone(l);
      }
      return null;
    },
    markApplied: async (lineId: string, error?: string | null): Promise<ApprovalLineRow | null> => {
      for (const r of this.approvalReqs.values()) {
        const l = r.lines.find((x) => x.id === lineId);
        if (!l) continue;
        l.appliedAt = new Date().toISOString(); l.applyError = error ?? null;
        return structuredClone(l);
      }
      return null;
    },
    markExecuted: async (lineId: string, by: { userId: string; name: string }, error?: string | null): Promise<ApprovalLineRow | null> => {
      for (const r of this.approvalReqs.values()) {
        const l = r.lines.find((x) => x.id === lineId);
        if (!l) continue;
        if (l.state !== "pending") return null;
        l.state = "executed"; l.decidedByUserId = by.userId; l.decidedByName = by.name;
        l.decidedAt = new Date().toISOString(); l.appliedAt = l.decidedAt; l.applyError = error ?? null;
        return structuredClone(l);
      }
      return null;
    },
    settle: async (requestId: string): Promise<ApprovalRequestRow | null> => {
      const r = this.approvalReqs.get(requestId);
      if (!r) return null;
      if (r.status === "open" && !r.lines.some((l) => l.state === "pending")) {
        r.status = "resolved"; r.resolvedAt = new Date().toISOString(); r.updatedAt = r.resolvedAt;
      }
      return structuredClone(r);
    },
    expireDue: async (nowIso: string): Promise<ApprovalRequestRow[]> => {
      const out: ApprovalRequestRow[] = [];
      for (const r of this.approvalReqs.values()) {
        if (r.status !== "open" || !r.expiresAt || r.expiresAt > nowIso) continue;
        r.status = "expired"; r.resolvedAt = new Date().toISOString(); r.updatedAt = r.resolvedAt;
        for (const l of r.lines) if (l.state === "pending") l.state = "voided";
        out.push(structuredClone(r));
      }
      return out;
    },
  };

  /** Mirror of eventWhere() in the Postgres store — one matcher for the listing and its count, so
   *  the two backends agree about what the game log's filters mean. */
  private eventMatches(q: EventQuery): EvtRow[] {
    const needle = q.q?.trim().toLowerCase();
    return this.evts.filter((e) => {
      if (e.serverId !== q.serverId) return false;
      if (q.kinds?.length && !q.kinds.includes(e.kind)) return false;
      if (q.playerId && e.actorPlayerId !== q.playerId && e.victimPlayerId !== q.playerId) return false;
      if (q.from && e.ts < q.from) return false;
      if (q.to && e.ts >= q.to) return false;
      if (needle) {
        const msg = String((e.data as Record<string, unknown> | null)?.message ?? "");
        const hit = (e.actorName ?? "").toLowerCase().includes(needle)
          || (e.victimName ?? "").toLowerCase().includes(needle)
          || msg.toLowerCase().includes(needle);
        if (!hit) return false;
      }
      return true;
    });
  }

  events = {
    insert: async (rows: NewEvt[]): Promise<NewEvt[]> => {
      const inserted: NewEvt[] = [];
      for (const r of rows) {
        // Idempotent by (serverId, dedupeKey): skip a repeat of an already-stored line.
        const key = r.dedupeKey ? `${r.serverId}|${r.dedupeKey}` : null;
        if (key && this.evtDedupe.has(key)) continue;
        if (key) this.evtDedupe.add(key);
        // Counted as inserted, but the body is dropped — see `countImportedEvents`. The dedupe key
        // is still held, so a repeated row is skipped here exactly as the real store would skip it.
        if (this.countImportedEvents && r.dedupeKey?.startsWith("crcon:")) {
          this.importedEvtCount += 1;
          inserted.push(r);
          continue;
        }
        this.evts.push({
          id: randomUUID(),
          serverId: r.serverId,
          ts: r.ts,
          kind: r.kind,
          actorPlayerId: r.actorPlayerId ?? null,
          actorName: r.actorName ?? null,
          victimPlayerId: r.victimPlayerId ?? null,
          victimName: r.victimName ?? null,
          weapon: r.weapon ?? null,
          data: r.data ?? null,
          dedupeKey: r.dedupeKey ?? null,
        });
        inserted.push(r);
      }
      return inserted;
    },
    listRecent: async (serverId: string, limit = 100): Promise<EvtRow[]> =>
      this.evts.filter((e) => e.serverId === serverId).sort((a, b) => b.ts.localeCompare(a.ts) || (b.dedupeKey ?? "").localeCompare(a.dedupeKey ?? "") || b.id.localeCompare(a.id)).slice(0, limit),
    query: async (q: EventQuery): Promise<EvtRow[]> => {
      const from = Math.max(q.offset ?? 0, 0);
      return this.eventMatches(q)
        // ts alone ties constantly on a busy server; id gives the total order paging needs.
        .sort((a, b) => b.ts.localeCompare(a.ts) || (b.dedupeKey ?? "").localeCompare(a.dedupeKey ?? "") || b.id.localeCompare(a.id))
        .slice(from, from + Math.min(Math.max(q.limit ?? 100, 1), 500));
    },
    window: async (q: EventWindowQuery): Promise<EvtRow[]> => this.eventMatches({ serverId: q.serverId, kinds: q.kinds, from: q.from, to: q.to })
      .sort((a, b) => b.ts.localeCompare(a.ts) || (b.dedupeKey ?? "").localeCompare(a.dedupeKey ?? "") || b.id.localeCompare(a.id))
      .slice(0, Math.max(1, Math.trunc(q.limit)))
      .reverse(),
    countQuery: async (q: EventQuery): Promise<number> => this.eventMatches(q).length,
    listByPlayer: async (playerId: string, limit = 100, kinds?: string[], opts: { offset?: number; serverId?: string; serverIds?: string[] } = {}): Promise<EvtRow[]> => {
      const offset = Math.max(0, opts.offset ?? 0);
      const allowed = opts.serverIds ? new Set(opts.serverIds) : null;
      return this.evts
        .filter((e) => (e.actorPlayerId === playerId || e.victimPlayerId === playerId)
          && (!kinds || kinds.includes(e.kind))
          && (!opts.serverId || e.serverId === opts.serverId)
          // The reader's boundary narrows BEFORE the slice below, as the SQL store's WHERE does.
          && (!allowed || allowed.has(e.serverId)))
        .sort((a, b) => b.ts.localeCompare(a.ts) || (b.dedupeKey ?? "").localeCompare(a.dedupeKey ?? "") || b.id.localeCompare(a.id))
        .slice(offset, offset + limit);
    },
    countByPlayer: async (playerId: string, kinds?: string[], serverId?: string, serverIds?: string[]): Promise<number> => {
      const allowed = serverIds ? new Set(serverIds) : null;
      return this.evts.filter((e) => (e.actorPlayerId === playerId || e.victimPlayerId === playerId)
        && (!kinds || kinds.includes(e.kind))
        && (!serverId || e.serverId === serverId)
        && (!allowed || allowed.has(e.serverId))).length;
    },
    fillImportedTeamSwitches: async (serverId: string, rows: { dedupeKey: string; ts: string; data: Record<string, unknown> }[]): Promise<number> => {
      const want = new Map(rows.filter((r) => r.dedupeKey.startsWith("crcon:")).map((r) => [`${r.dedupeKey}|${Date.parse(r.ts)}`, r.data]));
      let n = 0;
      // jsonb's IS DISTINCT FROM: the same keys and values, whatever order they were written in.
      const same = (a: unknown, b: unknown): boolean => {
        if (a === b) return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        const ka = Object.keys(a as object), kb = Object.keys(b as object);
        return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
      };
      for (const e of this.evts) {
        if (e.serverId !== serverId || e.kind !== "evt.player.teamSwitched" || !e.dedupeKey) continue;
        // A swap already named is never rewritten.
        const d = e.data as { swapFrom?: unknown } | null;
        if (d && typeof d === "object" && "swapFrom" in d) continue;
        const data = want.get(`${e.dedupeKey}|${Date.parse(e.ts)}`);
        if (data && !same(e.data, data)) { e.data = data; n += 1; }
      }
      return n;
    },
    firstLocalTs: async (serverId: string): Promise<string | null> => {
      let min: string | null = null;
      for (const e of this.evts) {
        if (e.serverId !== serverId || e.dedupeKey?.startsWith("crcon:")) continue;
        if (!min || e.ts < min) min = e.ts;
      }
      return min;
    },
    countForTrim: async (spec: TrimSpec): Promise<number> =>
      this.evts.filter((e) => spec.kinds.includes(e.kind) && e.ts < spec.olderThanIso).length,
    trim: async (spec: TrimSpec): Promise<TrimResult> => {
      const matched = this.evts.filter((e) => spec.kinds.includes(e.kind) && e.ts < spec.olderThanIso);
      if (spec.backupPath) await backupRowsNdjson(spec.backupPath, matched); // back up first; throws → nothing deleted
      const matchedIds = new Set(matched.map((e) => e.id));
      this.evts = this.evts.filter((e) => !matchedIds.has(e.id));
      return { deleted: matched.length, backupPath: spec.backupPath ?? null };
    },
  };

  /**
   * The memory mirror of the Postgres trimData: identical semantics over the in-memory
   * structures, including the backup files, so a test proving "old rows go, live rows stay,
   * children ride with parents, the archive holds everything deleted" proves the contract and
   * not one store's private behaviour. The open round and an admin still in camera are never
   * touched; last_seen datasets keep anything seen since the cutoff.
   */
  trimData = {
    preview: async (datasets: string[], olderThanIso: string): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const id of datasets) out[id] = this.trimMatch(id, olderThanIso).parents;
      return out;
    },
    run: async (datasets: string[], olderThanIso: string, backupDir: string | null): Promise<Record<string, TrimResult>> => {
      const out: Record<string, TrimResult> = {};
      for (const id of datasets) {
        const backupPath = backupDir ? `${backupDir}/trim-${id}-${Date.now()}.ndjson.gz` : null;
        const { parents, remove, backupRows } = this.trimMatch(id, olderThanIso);
        // Back up first, exactly as the event trim does: a failed write means nothing deleted.
        if (backupPath) await backupRowsNdjson(backupPath, backupRows);
        remove();
        out[id] = { deleted: parents, backupPath };
      }
      return out;
    },
  };

  /** One dataset's doomed rows: how many parents, the lines a backup writes (children included),
   *  and the closure that actually removes them. Shared by preview and run so they cannot drift. */
  private trimMatch(id: string, cutoff: string): { parents: number; backupRows: unknown[]; remove: () => void } {
    switch (id) {
      case "rosterSnapshots": {
        const doomed = this.rosterSnaps.filter((r) => r.ts < cutoff);
        return {
          parents: doomed.length,
          backupRows: doomed.map((row) => ({ table: "roster_snapshots", row })),
          remove: () => { this.rosterSnaps = this.rosterSnaps.filter((r) => !(r.ts < cutoff)); },
        };
      }
      case "playerSessions": {
        const doomed: PlayerSessionRow[] = [];
        for (const list of this.sessionsByPlayer.values()) for (const r of list) if (r.disconnectedAt < cutoff) doomed.push(r);
        return {
          parents: doomed.length,
          backupRows: doomed.map((row) => ({ table: "player_sessions", row })),
          remove: () => {
            for (const [k, list] of this.sessionsByPlayer) {
              const keep = list.filter((r) => !(r.disconnectedAt < cutoff));
              if (keep.length) this.sessionsByPlayer.set(k, keep); else this.sessionsByPlayer.delete(k);
            }
          },
        };
      }
      case "matches": {
        const doomed = [...this.matchesById.values()].filter((m) => m.endedAt !== null && m.endedAt < cutoff);
        const ids = new Set(doomed.map((m) => m.id));
        const childRows = [...this.matchStatsByKey.values()].filter((st) => ids.has(st.matchId));
        // The short rounds only the CRCON-compatible endpoints list age out with the rest.
        const shortGone = [...this.crconShortRounds.entries()].filter(([, r]) => r.row.endedAt !== null && r.row.endedAt < cutoff);
        return {
          parents: doomed.length,
          backupRows: [
            ...childRows.map((row) => ({ table: "player_match_stats", row })),
            ...doomed.map((row) => ({ table: "matches", row })),
            ...doomed.flatMap((m) => { const players = this.crconPlayerStats.get(m.id); return players ? [{ table: "crcon_player_stats", row: { matchId: m.id, players } }] : []; }),
            ...doomed.flatMap((m) => [...(this.scoreSeriesByMatch.get(m.id) ?? [])].map(([playerId, points]) => ({ table: "match_score_series", row: { matchId: m.id, playerId, points } }))),
            ...shortGone.map(([, r]) => ({ table: "crcon_short_rounds", row: r.row })),
          ],
          remove: () => {
            for (const m of doomed) { this.matchesById.delete(m.id); this.crconPlayerStats.delete(m.id); this.scoreSeriesByMatch.delete(m.id); }
            for (const [k, st] of this.matchStatsByKey) if (ids.has(st.matchId)) this.matchStatsByKey.delete(k);
            this.dropWeaponKills(ids);
            for (const [seq] of shortGone) this.crconShortRounds.delete(seq);
          },
        };
      }
      case "mapVotes": {
        const doomed = this.mapVoteHistory.filter((h) => h.decidedAt < cutoff);
        const ids = new Set(doomed.map((h) => h.id));
        const childRows = this.mapVoteBallots.filter((b) => ids.has(b.historyId));
        return {
          parents: doomed.length,
          backupRows: [
            ...childRows.map((row) => ({ table: "mapvote_ballots", row })),
            ...doomed.map((row) => ({ table: "mapvote_history", row })),
          ],
          remove: () => {
            this.mapVoteHistory = this.mapVoteHistory.filter((h) => !ids.has(h.id));
            this.mapVoteBallots = this.mapVoteBallots.filter((b) => !ids.has(b.historyId));
          },
        };
      }
      case "adminCam": {
        const doomed = this.adminCamSessions.filter((r) => r.exitedAt !== null && r.exitedAt < cutoff);
        const ids = new Set(doomed.map((r) => r.id));
        return {
          parents: doomed.length,
          backupRows: doomed.map((row) => ({ table: "admin_cam_sessions", row })),
          remove: () => { this.adminCamSessions = this.adminCamSessions.filter((r) => !ids.has(r.id)); },
        };
      }
      case "pluginKv": {
        // The map is keyed `namespace|key`, so the permanence test reads the half after the pipe —
        // a `keep:` row records something irreversible and is never collected. See
        // PERMANENT_KV_PREFIX in types.ts.
        const doomed = [...this.pluginKvByKey.entries()]
          .filter(([k, r]) => r.updatedAt < cutoff && !isPermanentKvKey(k.slice(k.indexOf("|") + 1)));
        return {
          parents: doomed.length,
          backupRows: doomed.map(([k, r]) => ({ table: "plugin_kv", row: { key: k, value: r.value, updated_at: r.updatedAt } })),
          remove: () => { for (const [k] of doomed) this.pluginKvByKey.delete(k); },
        };
      }
      case "ipHistory": {
        const doomed = [...this.playerIpsByKey.entries()].filter(([, r]) => r.lastSeen < cutoff);
        return {
          parents: doomed.length,
          backupRows: doomed.map(([, row]) => ({ table: "player_ips", row })),
          remove: () => { for (const [k] of doomed) this.playerIpsByKey.delete(k); },
        };
      }
      case "aliasHistory": {
        const doomed: PlayerAliasRow[] = [];
        for (const list of this.aliasesByPlayer.values()) for (const r of list) if (r.lastSeen < cutoff) doomed.push(r);
        return {
          parents: doomed.length,
          backupRows: doomed.map((row) => ({ table: "player_aliases", row })),
          remove: () => {
            for (const [k, list] of this.aliasesByPlayer) {
              const keep = list.filter((r) => !(r.lastSeen < cutoff));
              if (keep.length) this.aliasesByPlayer.set(k, keep); else this.aliasesByPlayer.delete(k);
            }
          },
        };
      }
      case "audit": {
        const doomed = this.auditLog.filter((r) => r.ts < cutoff);
        const ids = new Set(doomed.map((r) => r.id));
        return {
          parents: doomed.length,
          backupRows: doomed.map((row) => ({ table: "audit", row })),
          remove: () => { this.auditLog = this.auditLog.filter((r) => !ids.has(r.id)); },
        };
      }
      default:
        throw new Error(`unknown trim dataset: ${id}`);
    }
  }

  /** The exporter/importer works on raw Postgres table rows; the memory store has no tables to
   *  read or write, so it says so instead of faking an archive nothing could re-import. */
  dataPort = {
    supported: false,
    counts: async (_groups: string[]): Promise<Record<string, number>> => { throw new Error("data export/import requires a Postgres database"); },
    export: async (): Promise<{ tables: Record<string, number>; rows: number }> => { throw new Error("data export/import requires a Postgres database"); },
    import: async (): Promise<DataPortReport> => { throw new Error("data export/import requires a Postgres database"); },
    restore: async (): Promise<DataPortReport> => { throw new Error("data export/import requires a Postgres database"); },
  };

  /** Where a session closed at `ts` ends: there, or a day from its connect (SESSION_MAX_SEC),
   *  whichever is first — and its length to match. The Postgres store's LEAST, in JS. */
  private sessionEnd(start: string, ts: string): { end: string; durationSec: number } {
    const capped = Date.parse(start) + SESSION_MAX_SEC * 1000;
    const end = Date.parse(ts) > capped ? new Date(capped).toISOString() : ts;
    return { end, durationSec: Math.min(SESSION_MAX_SEC, Math.max(0, Math.round((Date.parse(ts) - Date.parse(start)) / 1000))) };
  }

  sessions = {
    open: async (playerId: string, serverId: string, ts: string): Promise<number> => {
      // A second connect with no disconnect between BANKS the first session rather than
      // overwriting it — see the Postgres store's `open` for why, and for why the new connect is
      // the honest end. A connect at or before the open session's start is old news arriving
      // late, and leaves the newer row alone.
      const key = `${playerId}|${serverId}`;
      const start = this.openSessions.get(key);
      if (start !== undefined && !(start < ts)) return 0;
      let banked = 0;
      if (start !== undefined) {
        const list = this.sessionsByPlayer.get(playerId) ?? [];
        const { end, durationSec } = this.sessionEnd(start, ts);
        if (!list.some((x) => x.serverId === serverId && x.connectedAt === start)) {
          list.push({ id: randomUUID(), playerId, serverId, connectedAt: start, disconnectedAt: end, durationSec });
          this.sessionsByPlayer.set(playerId, list);
          banked = durationSec;
        }
      }
      this.openSessions.set(key, ts);
      return banked;
    },
    close: async (playerId: string, serverId: string, ts: string): Promise<number> => {
      const key = `${playerId}|${serverId}`;
      const start = this.openSessions.get(key);
      if (!start) return 0;
      this.openSessions.delete(key);
      const { end, durationSec } = this.sessionEnd(start, ts);
      const list = this.sessionsByPlayer.get(playerId) ?? [];
      list.push({ id: randomUUID(), playerId, serverId, connectedAt: start, disconnectedAt: end, durationSec });
      this.sessionsByPlayer.set(playerId, list);
      return durationSec;
    },
    list: async (playerId: string, limit = 50, serverId?: string): Promise<PlayerSessionRow[]> =>
      (this.sessionsByPlayer.get(playerId) ?? [])
        .filter((s) => !serverId || s.serverId === serverId)
        .slice().sort((a, b) => b.disconnectedAt.localeCompare(a.disconnectedAt) || b.id.localeCompare(a.id)).slice(0, limit),
    inWindow: async (serverId: string, fromIso: string, toIso: string): Promise<{ playerId: string; connectedAt: string; disconnectedAt: string }[]> => {
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      const out: { playerId: string; connectedAt: string; disconnectedAt: string }[] = [];
      for (const list of this.sessionsByPlayer.values()) {
        for (const r of list) {
          // Overlap, not containment: a session wrapped around the window still counts, and the
          // caller (windowMinutes) clips it to the window itself.
          if (r.serverId === serverId && Date.parse(r.connectedAt) < to && Date.parse(r.disconnectedAt) > from) {
            out.push({ playerId: r.playerId, connectedAt: r.connectedAt, disconnectedAt: r.disconnectedAt });
          }
        }
      }
      return out.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt) || a.playerId.localeCompare(b.playerId));
    },
    openServers: async (playerId: string): Promise<string[]> =>
      [...this.openSessions.keys()].filter((k) => k.startsWith(`${playerId}|`)).map((k) => k.split("|")[1]!),
    latestFor: async (playerIds: string[]): Promise<Map<string, { connectedAt: string; disconnectedAt: string | null }>> => {
      const want = new Set(playerIds);
      const out = new Map<string, { connectedAt: string; disconnectedAt: string | null }>();
      const offer = (playerId: string, connectedAt: string, disconnectedAt: string | null) => {
        const had = out.get(playerId);
        if (!had || connectedAt > had.connectedAt || (connectedAt === had.connectedAt && disconnectedAt === null)) out.set(playerId, { connectedAt, disconnectedAt });
      };
      for (const id of want) {
        const closed = (this.sessionsByPlayer.get(id) ?? []).reduce<PlayerSessionRow | null>((best, r) => (!best || r.disconnectedAt > best.disconnectedAt ? r : best), null);
        if (closed) offer(id, closed.connectedAt, closed.disconnectedAt);
      }
      for (const [key, connectedAt] of this.openSessions) {
        const playerId = key.slice(0, key.indexOf("|"));
        if (want.has(playerId)) offer(playerId, connectedAt, null);
      }
      return out;
    },
    openServersFor: async (playerIds: string[]): Promise<Map<string, string[]>> => {
      const want = new Set(playerIds);
      const out = new Map<string, string[]>();
      for (const key of this.openSessions.keys()) {
        const i = key.indexOf("|");
        const playerId = key.slice(0, i);
        if (!want.has(playerId)) continue;
        out.set(playerId, [...(out.get(playerId) ?? []), key.slice(i + 1)]);
      }
      return out;
    },
    openOnServer: async (serverId: string): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      for (const [key, ts] of this.openSessions) {
        const i = key.indexOf("|");
        if (key.slice(i + 1) === serverId) out.set(key.slice(0, i), ts);
      }
      return out;
    },
    closeAbsent: async (serverId: string, presentPlayerIds: string[], connectedBeforeIso: string, ts: string): Promise<number> => {
      const present = new Set(presentPlayerIds);
      let closed = 0;
      for (const [key, start] of [...this.openSessions]) {
        const i = key.indexOf("|");
        const playerId = key.slice(0, i);
        if (key.slice(i + 1) !== serverId) continue;
        if (present.has(playerId)) continue;
        if (start >= connectedBeforeIso) continue; // inside the grace — too fresh to judge absent
        this.openSessions.delete(key);
        // Capped at the start: the reaper's end is the last time anything observed the server (see
        // the worker's session-reap), which for a session that began during the blind spot can be
        // earlier than the session itself. Zero length is the honest floor; negative is nonsense.
        const { end, durationSec } = this.sessionEnd(start, ts < start ? start : ts);
        const list = this.sessionsByPlayer.get(playerId) ?? [];
        list.push({ id: randomUUID(), playerId, serverId, connectedAt: start, disconnectedAt: end, durationSec });
        this.sessionsByPlayer.set(playerId, list);
        closed++;
      }
      return closed;
    },
    importOne: async (input: { playerId: string; serverId: string; connectedAt: string; disconnectedAt: string; durationSec: number }): Promise<boolean> => {
      const list = this.sessionsByPlayer.get(input.playerId) ?? [];
      if (list.some((s) => s.serverId === input.serverId && s.connectedAt === input.connectedAt)) return false;
      list.push({ id: randomUUID(), playerId: input.playerId, serverId: input.serverId, connectedAt: input.connectedAt, disconnectedAt: input.disconnectedAt, durationSec: input.durationSec });
      this.sessionsByPlayer.set(input.playerId, list);
      return true;
    },
    importMany: async (rows: ImportedSession[]): Promise<ImportedSession[]> => {
      // The loop IS the batch here; importOne already carries the dedupe rule, so deferring to it
      // keeps the two stores' definition of "newly inserted" identical by construction.
      const out: ImportedSession[] = [];
      for (const r of rows) if (await this.sessions.importOne(r)) out.push(r);
      return out;
    },
  };

  /** A per-server career row with every counter zeroed — the shape both stores must agree on. */
  private blankStats(playerId: string, serverId: string | null): PlayerStatsRow {
    return {
      playerId, serverId, kills: 0, deaths: 0, teamkills: 0, visits: 0, playtimeSec: 0,
      combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
      roleSeconds: {}, slSeconds: 0, highestLevel: 0, matchesPlayed: 0, matchesWon: 0, updatedAt: "",
    };
  }

  /** The (player, server) key that mirrors the Postgres primary key. */
  private statsKey(playerId: string, serverId: string): string {
    return `${playerId}|${serverId}`;
  }

  /** Every server's row for one player. */
  private statsRowsFor(playerId: string): PlayerStatsRow[] {
    return [...this.statsByPlayer.values()].filter((s) => s.playerId === playerId);
  }

  /**
   * Fold a player's per-server rows into the career total, matching the SQL aggregate in the
   * Postgres store: counters add, `highestLevel` takes the max because a level is a high-water
   * mark, role clocks merge key by key, and `serverId` comes back null to say "this is a total".
   */
  private foldStats(rows: PlayerStatsRow[]): PlayerStatsRow | null {
    if (rows.length === 0) return null;
    const out = this.blankStats(rows[0]!.playerId, null);
    for (const r of rows) {
      out.kills += r.kills; out.deaths += r.deaths; out.teamkills += r.teamkills;
      out.visits += r.visits; out.playtimeSec += r.playtimeSec;
      out.combat += r.combat; out.offense += r.offense; out.defense += r.defense; out.support += r.support;
      out.vehicleKills += r.vehicleKills; out.vehiclesDestroyed += r.vehiclesDestroyed;
      out.slSeconds += r.slSeconds;
      out.matchesPlayed += r.matchesPlayed; out.matchesWon += r.matchesWon;
      out.highestLevel = Math.max(out.highestLevel, r.highestLevel);
      for (const [k, v] of Object.entries(r.roleSeconds)) out.roleSeconds[k] = (out.roleSeconds[k] ?? 0) + v;
      if (r.updatedAt > out.updatedAt) out.updatedAt = r.updatedAt;
    }
    return out;
  }

  stats = {
    bump: async (playerId: string, serverId: string, delta: StatsDelta): Promise<void> => {
      if (!serverId) return;
      const key = this.statsKey(playerId, serverId);
      const row = this.statsByPlayer.get(key) ?? this.blankStats(playerId, serverId);
      row.kills += delta.kills ?? 0;
      row.deaths += delta.deaths ?? 0;
      row.teamkills += delta.teamkills ?? 0;
      row.visits += delta.visits ?? 0;
      row.playtimeSec += delta.playtimeSec ?? 0;
      row.updatedAt = new Date().toISOString();
      this.statsByPlayer.set(key, row);
    },
    bumpMany: async (deltas: { playerId: string; serverId: string; delta: StatsDelta }[]): Promise<void> => {
      // Deliberately the single-row fold in a loop: in memory there is no round trip to save, and
      // reimplementing the arithmetic is how the two stores drift apart.
      for (const { playerId, serverId, delta } of deltas) if (playerId) await this.stats.bump(playerId, serverId, delta);
    },
    settlePlaytimeFromSessions: async (serverId: string, beforeTs: string | null): Promise<number> => {
      // Mirrors the SQL version: raise-only against the recorded session history, so re-running
      // never lowers a rollup that already carries live-era seconds.
      const sums = new Map<string, number>();
      for (const list of this.sessionsByPlayer.values()) {
        for (const sess of list) {
          if (sess.serverId !== serverId) continue;
          if (beforeTs && !(sess.disconnectedAt < beforeTs)) continue;
          sums.set(sess.playerId, (sums.get(sess.playerId) ?? 0) + sess.durationSec);
        }
      }
      let raised = 0;
      for (const [playerId, total] of sums) {
        const key = this.statsKey(playerId, serverId);
        const row = this.statsByPlayer.get(key) ?? this.blankStats(playerId, serverId);
        if (row.playtimeSec >= total) continue;
        row.playtimeSec = total;
        row.updatedAt = new Date().toISOString();
        this.statsByPlayer.set(key, row);
        raised += 1;
      }
      return raised;
    },
    get: async (playerId: string, serverId?: string): Promise<PlayerStatsRow | null> => {
      if (serverId) return this.statsByPlayer.get(this.statsKey(playerId, serverId)) ?? null;
      return this.foldStats(this.statsRowsFor(playerId));
    },
    byServer: async (playerId: string): Promise<PlayerStatsRow[]> =>
      this.statsRowsFor(playerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    playtimeFor: async (playerIds: string[], opts: { serverId: string | null; since: string | null }): Promise<Map<string, number>> => {
      const out = new Map<string, number>();
      for (const id of playerIds) {
        let sec = 0;
        if (opts.since === null) {
          for (const row of this.statsByPlayer.values()) {
            if (row.playerId === id && (opts.serverId === null || row.serverId === opts.serverId)) sec += row.playtimeSec;
          }
        } else {
          const bound = Date.parse(opts.since);
          for (const sess of this.sessionsByPlayer.get(id) ?? []) {
            if (opts.serverId !== null && sess.serverId !== opts.serverId) continue;
            const end = Date.parse(sess.disconnectedAt);
            if (end <= bound) continue;
            sec += Math.max(0, Math.min(sess.durationSec, (end - bound) / 1000));
          }
        }
        if (sec > 0) out.set(id, Math.round(sec));
      }
      return out;
    },
    visitsFor: async (playerIds: string[], serverId: string): Promise<Map<string, { visits: number; playtimeSec: number }>> => {
      const out = new Map<string, { visits: number; playtimeSec: number }>();
      for (const id of playerIds) {
        const row = this.statsByPlayer.get(this.statsKey(id, serverId));
        if (row) out.set(id, { visits: row.visits, playtimeSec: row.playtimeSec });
      }
      return out;
    },
    leaderboard: async (sort: LeaderboardSort, limit = 100, serverIds?: string[], offset = 0): Promise<LeaderboardEntry[]> => {
      if (serverIds?.length === 0) return [];
      // One line per player either way; the only difference is which servers' rows go into the
      // fold — the same choice the SQL board makes, and never a silent merge.
      const rows = serverIds
        ? [...this.statsByPlayer.values()].filter((s) => s.serverId != null && serverIds.includes(s.serverId))
        : [...this.statsByPlayer.values()];
      const source = [...new Set(rows.map((s) => s.playerId))]
        .map((id) => this.foldStats(rows.filter((s) => s.playerId === id))!)
        .filter(Boolean);
      const entries: LeaderboardEntry[] = [];
      for (const s of source) {
        const p = this.playersById.get(s.playerId);
        if (!p) continue;
        entries.push({
          playerId: s.playerId, name: p.name, platform: p.platform,
          kills: s.kills, deaths: s.deaths, teamkills: s.teamkills, kd: computeKd(s.kills, s.deaths),
          combat: s.combat, offense: s.offense, defense: s.defense, support: s.support,
          slSeconds: s.slSeconds, playtime: s.playtimeSec,
        });
      }
      // Tie-break on the platform id, exactly as the SQL board does. Ties are the common case on
      // these boards — half a server sits on zero teamkills — and a LIMIT through an unordered tie
      // makes the cut wobble between refreshes. LeaderboardEntry carries no platform id (it is not
      // for display), so it is looked up rather than added to the shape.
      const tieKey = (e: LeaderboardEntry) => this.playersById.get(e.playerId)?.platformId ?? e.playerId;
      entries.sort((a, b) => b[sort] - a[sort] || tieKey(a).localeCompare(tieKey(b)));
      return entries.slice(offset, offset + limit);
    },
    // The board's own length, so the count can only ever be of the lines it ranks.
    leaderboardCount: async (serverIds?: string[]): Promise<number> =>
      (await this.stats.leaderboard("kills", Number.MAX_SAFE_INTEGER, serverIds)).length,
    sampleRoster: async (input: { serverId: string; matchId: string | null; sampleSec: number; players: RosterSampleRow[] }): Promise<void> => {
      const sec = Math.max(0, Math.round(input.sampleSec));
      // Same dedupe as the Postgres store: one row per platform id, last wins — a roster that
      // lists a player twice must not double their clocks.
      const byPlatform = new Map<string, RosterSampleRow>();
      for (const p of input.players) if (p.platformId) byPlatform.set(p.platformId, p);
      // Same gate as Postgres's `mt`: score reaches careers only once the open round has run
      // MIN_MATCH_MS, and the first ripe sample diffs against nothing, bringing the round in whole.
      const openRound = input.matchId ? this.matchesById.get(input.matchId) : undefined;
      const ripe = !!openRound && Date.now() - Date.parse(openRound.startedAt) >= MIN_MATCH_MS;
      const credited = !!input.matchId && this.matchScoresCredited.has(input.matchId);
      for (const s of byPlatform.values()) {
        if (!s.platformId) continue;
        const player = [...this.playersById.values()].find((p) => p.platformId === s.platformId);
        if (!player) continue;

        // Snapshot what the match line held BEFORE this sample. `matchLine` below is the stored
        // object, so mutating it first would leave nothing to diff the career against and every
        // delta would come out zero.
        const before = input.matchId && credited ? this.matchStatsByKey.get(`${input.matchId}|${player.id}`) : undefined;
        const prevScore = {
          combat: before?.combat ?? 0, offense: before?.offense ?? 0, defense: before?.defense ?? 0,
          support: before?.support ?? 0, vehicleKills: before?.vehicleKills ?? 0,
          vehiclesDestroyed: before?.vehiclesDestroyed ?? 0,
        };

        // Match line: max-wins on score (the game reports the round's running total), clocks add.
        let matchLine: PlayerMatchStatRow | undefined;
        if (input.matchId) {
          const key = `${input.matchId}|${player.id}`;
          matchLine = this.matchStatsByKey.get(key) ?? {
            matchId: input.matchId, playerId: player.id, serverId: input.serverId, playerName: player.name,
            side: null, kills: 0, deaths: 0, teamkills: 0,
            combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
            roleSeconds: {}, slSeconds: 0,
            killsAndAssists: 0, killsAndAssistsPrev: 0, deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0,
            units: [],
            won: null, presentAtEnd: null, updatedAt: "",
          };
          matchLine.combat = Math.max(matchLine.combat, Math.round(s.score?.combat ?? 0));
          matchLine.offense = Math.max(matchLine.offense, Math.round(s.score?.offense ?? 0));
          matchLine.defense = Math.max(matchLine.defense, Math.round(s.score?.defense ?? 0));
          matchLine.support = Math.max(matchLine.support, Math.round(s.score?.support ?? 0));
          matchLine.vehicleKills = Math.max(matchLine.vehicleKills, Math.round(s.score?.vehicleKills ?? 0));
          matchLine.vehiclesDestroyed = Math.max(matchLine.vehiclesDestroyed, Math.round(s.score?.vehiclesDestroyed ?? 0));

          // The GAME's own counters. NOT max-wins like the score buckets above: these reset when a
          // player reconnects mid-round, and a max would freeze the round at its pre-reconnect
          // peak. A value that went down banks the old total in *Prev and starts again, which is
          // what CRCON's p_ fields do. Mirrors the CASE in postgres.ts — keep the two together.
          const ka = Math.max(0, Math.round(s.score?.killsAndAssists ?? 0));
          if (ka < matchLine.killsAndAssists) matchLine.killsAndAssistsPrev += matchLine.killsAndAssists;
          matchLine.killsAndAssists = ka;
          const dr = Math.max(0, Math.round(s.score?.deathsAndRedeploys ?? 0));
          if (dr < matchLine.deathsAndRedeploys) matchLine.deathsAndRedeploysPrev += matchLine.deathsAndRedeploys;
          matchLine.deathsAndRedeploys = dr;

          // One unit leg per CHANGE of (team, squad, role), timestamped from the round's start.
          const leg = {
            ts: Math.max(0, Math.round((Date.now() - Date.parse(this.matchesById.get(input.matchId)?.startedAt ?? "")) / 1000)) || 0,
            team: s.side === "allies" ? 1 : s.side === "axis" ? 2 : 0,
            squad: s.squad == null ? -1 : Math.round(s.squad),
            role: s.role == null ? -1 : Number(s.role),
          };
          const last = matchLine.units[matchLine.units.length - 1];
          if (!last || last.team !== leg.team || last.squad !== leg.squad || last.role !== leg.role) {
            matchLine.units = [...matchLine.units, leg];
          }
        }

        // Career: score adds only the increase over the pre-sample match values, so replaying a
        // sample is a no-op rather than a double count.
        const gain = (now: number | undefined, was: number) =>
          ripe ? Math.max(0, Math.round(now ?? 0) - was) : 0;

        const careerKey = this.statsKey(player.id, input.serverId);
        const career = this.statsByPlayer.get(careerKey) ?? this.blankStats(player.id, input.serverId);
        career.combat += gain(s.score?.combat, prevScore.combat);
        career.offense += gain(s.score?.offense, prevScore.offense);
        career.defense += gain(s.score?.defense, prevScore.defense);
        career.support += gain(s.score?.support, prevScore.support);
        career.vehicleKills += gain(s.score?.vehicleKills, prevScore.vehicleKills);
        career.vehiclesDestroyed += gain(s.score?.vehiclesDestroyed, prevScore.vehiclesDestroyed);
        if (s.role != null) {
          const k = String(s.role);
          career.roleSeconds[k] = (career.roleSeconds[k] ?? 0) + sec;
          if (matchLine) matchLine.roleSeconds[k] = (matchLine.roleSeconds[k] ?? 0) + sec;
        }
        if (s.isSquadLead) {
          career.slSeconds += sec;
          if (matchLine) matchLine.slSeconds += sec;
        }
        career.highestLevel = Math.max(career.highestLevel, Math.round(s.level ?? 0));
        career.updatedAt = new Date().toISOString();
        this.statsByPlayer.set(careerKey, career);
        if (matchLine && input.matchId) {
          matchLine.updatedAt = new Date().toISOString();
          this.matchStatsByKey.set(`${input.matchId}|${player.id}`, matchLine);
        }
      }
      if (ripe && input.matchId) this.matchScoresCredited.add(input.matchId);
    },
    settleMatch: async (matchId: string, winner: "allies" | "axis" | null): Promise<void> => {
      const match = this.matchesById.get(matchId);
      // Guarded like Postgres: closing twice must not double-count played/won. settled_at is a
      // real column — it used to be a marker word smuggled into result, which the panel displays.
      const settled = match?.settledAt != null;
      for (const [key, line] of this.matchStatsByKey) {
        if (!key.startsWith(`${matchId}|`)) continue;
        // openSessions is keyed `${playerId}|${serverId}` → connectedAt, so presence is a lookup.
        line.presentAtEnd = this.openSessions.has(`${line.playerId}|${line.serverId}`);
        line.won = winner === null || line.side == null ? null : line.side === winner;
        line.updatedAt = new Date().toISOString();
        if (!settled) {
          // The match line carries the server the round was played on, so played/won land on that
          // server's row rather than a merged one. Scores the sampler never credited (the round
          // ended before its first ripe sample) come in with them, as in Postgres.
          const careerKey = this.statsKey(line.playerId, line.serverId);
          const career = this.statsByPlayer.get(careerKey) ?? this.blankStats(line.playerId, line.serverId);
          career.matchesPlayed += 1;
          if (line.won) career.matchesWon += 1;
          if (!this.matchScoresCredited.has(matchId)) {
            career.combat += line.combat;
            career.offense += line.offense;
            career.defense += line.defense;
            career.support += line.support;
            career.vehicleKills += line.vehicleKills;
            career.vehiclesDestroyed += line.vehiclesDestroyed;
          }
          career.updatedAt = new Date().toISOString();
          this.statsByPlayer.set(careerKey, career);
        }
      }
      if (match && !settled) {
        match.settledAt = new Date().toISOString();
        this.matchScoresCredited.add(matchId);
      }
    },
  };

  announcements = {
    markRead: async (userId: string, announcementIds: string[]): Promise<void> => {
      for (const id of announcementIds) {
        const a = this.announcementsById.get(id);
        if (!a || !a.published) continue;
        const key = `${id}|${userId}`;
        if (!this.announcementReadsByKey.has(key)) {
          this.announcementReadsByKey.set(key, { announcementId: id, userId, readAt: new Date().toISOString(), acknowledgedAt: null });
        }
      }
    },
    acknowledge: async (announcementId: string, userId: string): Promise<AnnouncementReadRow | null> => {
      const a = this.announcementsById.get(announcementId);
      if (!a || !a.published) return null;
      const key = `${announcementId}|${userId}`;
      const now = new Date().toISOString();
      const existing = this.announcementReadsByKey.get(key);
      const row: AnnouncementReadRow = existing
        ? { ...existing, acknowledgedAt: existing.acknowledgedAt ?? now }
        : { announcementId, userId, readAt: now, acknowledgedAt: now };
      this.announcementReadsByKey.set(key, row);
      return row;
    },
    reads: async (announcementId: string): Promise<AnnouncementReadRow[]> =>
      [...this.announcementReadsByKey.values()].filter((r) => r.announcementId === announcementId).sort((a, b) => a.readAt.localeCompare(b.readAt)),
    readsForUser: async (userId: string): Promise<AnnouncementReadRow[]> =>
      [...this.announcementReadsByKey.values()].filter((r) => r.userId === userId),
    getNudgeConfig: async (): Promise<AnnouncementNudgeConfig> => ({ ...(this.nudgeConfig ?? ANNOUNCEMENT_NUDGE_DEFAULTS) }),
    setNudgeConfig: async (patch: Partial<AnnouncementNudgeConfig>): Promise<AnnouncementNudgeConfig> => {
      this.nudgeConfig = { ...(this.nudgeConfig ?? ANNOUNCEMENT_NUDGE_DEFAULTS), ...patch };
      return { ...this.nudgeConfig };
    },
    markNudged: async (id: string): Promise<void> => {
      const row = this.announcementsById.get(id);
      if (row) row.nudgedAt = new Date().toISOString();
    },
    create: async (input: NewAnnouncement): Promise<AnnouncementRow> => {
      const now = new Date().toISOString();
      const row: AnnouncementRow = {
        id: randomUUID(),
        title: input.title,
        body: input.body,
        published: input.published ?? false,
        publishedAt: input.published ? now : null,
        nudgedAt: null,
        authorUserId: input.authorUserId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.announcementsById.set(row.id, row);
      return row;
    },
    listPublished: async (limit = 50, offset = 0) =>
      [...this.announcementsById.values()].filter((a) => a.published).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(offset, offset + limit),
    countPublished: async () => [...this.announcementsById.values()].filter((a) => a.published).length,
    listAll: async (limit = 100, offset = 0) => [...this.announcementsById.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(offset, offset + limit),
    countAll: async () => this.announcementsById.size,
    // A copy, as Postgres hands out: a notice read before an edit keeps saying what it said then —
    // which is how the edit route tells "posted" from "edited".
    get: async (id: string) => { const a = this.announcementsById.get(id); return a ? { ...a } : null; },
    update: async (id: string, patch: AnnouncementPatch): Promise<AnnouncementRow | null> => {
      const row = this.announcementsById.get(id);
      if (!row) return null;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.body !== undefined) row.body = patch.body;
      if (patch.published !== undefined) {
        // every draft→posted transition re-anchors time-to-see and earns a fresh nudge cycle
        if (patch.published && !row.published) { row.publishedAt = new Date().toISOString(); row.nudgedAt = null; }
        row.published = patch.published;
      }
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string) => {
      for (const key of [...this.announcementReadsByKey.keys()]) if (key.startsWith(`${id}|`)) this.announcementReadsByKey.delete(key);
      return this.announcementsById.delete(id);
    },
  };

  templates = {
    list: async (kind?: string): Promise<MessageTemplateRow[]> => {
      let rows = [...this.templatesById.values()];
      if (kind) rows = rows.filter((t) => t.kind === kind);
      return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder);
    },
    create: async (input: NewMessageTemplate): Promise<MessageTemplateRow> => {
      const row: MessageTemplateRow = {
        id: randomUUID(), kind: input.kind, title: input.title ?? "", body: input.body,
        sortOrder: input.sortOrder ?? this.templatesById.size, updatedAt: new Date().toISOString(),
      };
      this.templatesById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: MessageTemplatePatch): Promise<MessageTemplateRow | null> => {
      const row = this.templatesById.get(id);
      if (!row) return null;
      if (patch.kind !== undefined) row.kind = patch.kind;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.body !== undefined) row.body = patch.body;
      if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.templatesById.delete(id),
  };

  private seededVipPresets = false;
  // Mirrors the 008_vip_presets INSERT (the in-memory store never runs SQL migrations).
  private seedVipPresetsOnce(): void {
    if (this.seededVipPresets) return;
    this.seededVipPresets = true;
    const seed: [VipPresetRow["kind"], string, number, number][] = [
      ["add", "Help skip queue", 0, 2], ["add", "1 day", 1, 0], ["add", "1 week", 7, 0], ["add", "1 month", 30, 0],
      ["pause", "1 day", 1, 0], ["pause", "1 week", 7, 0], ["pause", "1 month", 30, 0],
    ];
    const counters: Record<string, number> = {};
    for (const [kind, label, days, hours] of seed) {
      const sortOrder = counters[kind] = (counters[kind] ?? -1) + 1;
      const id = randomUUID();
      this.vipPresetsById.set(id, { id, kind, label, days, hours, sortOrder });
    }
  }

  vipPresets = {
    list: async (): Promise<VipPresetRow[]> => {
      this.seedVipPresetsOnce();
      return [...this.vipPresetsById.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    },
    create: async (input: NewVipPreset): Promise<VipPresetRow> => {
      this.seedVipPresetsOnce();
      const row: VipPresetRow = { id: randomUUID(), kind: input.kind, label: input.label, days: input.days, hours: input.hours, sortOrder: input.sortOrder ?? this.vipPresetsById.size };
      this.vipPresetsById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: VipPresetPatch): Promise<VipPresetRow | null> => {
      const row = this.vipPresetsById.get(id);
      if (!row) return null;
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.days !== undefined) row.days = patch.days;
      if (patch.hours !== undefined) row.hours = patch.hours;
      if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.vipPresetsById.delete(id),
  };

  analytics = {
    sessionActivity: async (q: AnalyticsWindow): Promise<SessionActivity> => {
      const rows = [...this.sessionsByPlayer.values()].flat().filter((r) =>
        r.connectedAt >= q.from && r.connectedAt < q.to && (!q.serverId || r.serverId === q.serverId));
      const byHour = Array<number>(24).fill(0);
      const byDow = Array<number>(7).fill(0);
      const weekHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      const perDay = new Map<string, { sessions: number; players: Set<string>; seconds: number }>();
      const players = new Set<string>();
      let totalSeconds = 0;
      // The same zone the Postgres store buckets in, so the two answer identically.
      const zone = q.tz ?? "UTC";
      for (const r of rows) {
        const d = new Date(r.connectedAt);
        const p = zonedParts(d, zone);
        const hour = Math.floor(p.minutes / 60);
        const dow = WEEKDAY_ORDER.indexOf(p.weekday);
        byHour[hour] = (byHour[hour] ?? 0) + 1;
        byDow[dow] = (byDow[dow] ?? 0) + 1;
        const wh = weekHour[dow]!;
        wh[hour] = (wh[hour] ?? 0) + 1;
        const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
        const day = perDay.get(key) ?? { sessions: 0, players: new Set<string>(), seconds: 0 };
        day.sessions += 1; day.players.add(r.playerId); day.seconds += r.durationSec;
        perDay.set(key, day);
        players.add(r.playerId);
        totalSeconds += r.durationSec;
      }
      // Same percentile definition as Postgres' percentile_cont on a sorted list.
      const lens = rows.map((r) => r.durationSec).sort((a, b) => a - b);
      const quantile = (p: number) => {
        if (!lens.length) return 0;
        const pos = (lens.length - 1) * p;
        const lo = Math.floor(pos), hi = Math.ceil(pos);
        return Math.round(lens[lo]! + (lens[hi]! - lens[lo]!) * (pos - lo));
      };
      return {
        byHour, byDow, weekHour,
        daily: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([date, v]) => ({ date, sessions: v.sessions, players: v.players.size, seconds: v.seconds })),
        sessions: rows.length,
        uniquePlayers: players.size,
        totalSeconds,
        medianSec: quantile(0.5),
        p90Sec: quantile(0.9),
        shortSessions: rows.filter((r) => r.durationSec < SHORT_SESSION_SEC).length,
        shortCutoffSec: SHORT_SESSION_SEC,
        earlyLeaversByMap: (() => {
          // Per SESSION: the latest round started before they joined — its map if it was still
          // running at that moment, otherwise 'Unknown'. Mirrors the Postgres lateral, so each
          // session lands on exactly one map and an overlapping stale round cannot add a second.
          const acc = new Map<string, { map: string; sessions: number; short: number }>();
          const all = [...this.matchesById.values()];
          for (const r of rows) {
            let latest: (typeof all)[number] | null = null;
            for (const m of all) {
              if (m.serverId !== r.serverId || m.startedAt > r.connectedAt) continue;
              if (!latest || m.startedAt > latest.startedAt) latest = m;
            }
            const live = latest && (latest.endedAt === null || latest.endedAt > r.connectedAt);
            const key = live ? (latest!.map ?? "Unknown") : "Unknown";
            const row = acc.get(key) ?? { map: key, sessions: 0, short: 0 };
            row.sessions += 1;
            if (r.durationSec < SHORT_SESSION_SEC) row.short += 1;
            acc.set(key, row);
          }
          return [...acc.values()].sort((a, b) => b.sessions - a.sessions);
        })(),
      };
    },
    platformBreakdown: async (q: AnalyticsWindow): Promise<PlatformBreakdown> => {
      // Mirrors the Postgres pair of grouped scans: presence from sessions (placed by connect),
      // performance from finished rounds (placed by start).
      const byPlatform = new Map<string, PlatformBreakdown["rows"][number]>();
      const at = (platform: string) => {
        const row = byPlatform.get(platform) ?? { platform, ...emptyPlatformSums() };
        byPlatform.set(platform, row);
        return row;
      };
      const platformOf = (playerId: string) => this.playersById.get(playerId)?.platform ?? "unknown";
      const seen = new Map<string, Set<string>>();
      const fresh = new Map<string, Set<string>>();
      for (const r of [...this.sessionsByPlayer.values()].flat()) {
        if (q.serverId && r.serverId !== q.serverId) continue;
        if (r.connectedAt < q.from || r.connectedAt >= q.to) continue;
        const platform = platformOf(r.playerId);
        foldMemorySession(at(platform), r);
        const ids = seen.get(platform) ?? new Set<string>();
        ids.add(r.playerId); seen.set(platform, ids);
        // New is the scoped player mix's rule: first seen inside the window.
        const firstSeen = this.playersById.get(r.playerId)?.firstSeen;
        if (firstSeen !== undefined && firstSeen >= q.from) {
          const nids = fresh.get(platform) ?? new Set<string>();
          nids.add(r.playerId); fresh.set(platform, nids);
        }
      }
      for (const [platform, ids] of seen) at(platform).players = ids.size;
      for (const [platform, ids] of fresh) at(platform).newPlayers = ids.size;
      for (const st of this.matchStatsByKey.values()) {
        if (q.serverId && st.serverId !== q.serverId) continue;
        const m = this.matchesById.get(st.matchId);
        if (!m || m.endedAt === null || m.startedAt < q.from || m.startedAt >= q.to) continue;
        foldMemoryRound(at(platformOf(st.playerId)), st);
      }
      return { rows: [...byPlatform.values()].sort((a, b) => b.players - a.players || b.kills - a.kills || a.platform.localeCompare(b.platform)) };
    },
    platformTrend: async (q: AnalyticsWindow): Promise<PlatformTrend> => {
      // The breakdown's two scans with the LOCAL day added to the key — the same zone bucketing
      // as sessionActivity, mirroring the Postgres twin.
      const zone = q.tz ?? "UTC";
      const dayOf = (iso: string) => {
        const p = zonedParts(new Date(iso), zone);
        return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      };
      const platformOf = (playerId: string) => this.playersById.get(playerId)?.platform ?? "unknown";
      const byKey = new Map<string, PlatformTrend["rows"][number]>();
      const at = (date: string, platform: string) => {
        const key = `${date}|${platform}`;
        const row = byKey.get(key) ?? emptyPlatformTrendRow(date, platform);
        byKey.set(key, row);
        return row;
      };
      const seen = new Map<string, Set<string>>(); // "date|platform" → distinct player ids
      const fresh = new Map<string, Set<string>>(); // … of whom first seen that same local day
      const firstAt = new Map<string, string>(); // player → their first session in the window
      for (const r of [...this.sessionsByPlayer.values()].flat()) {
        if (q.serverId && r.serverId !== q.serverId) continue;
        if (r.connectedAt < q.from || r.connectedAt >= q.to) continue;
        const was = firstAt.get(r.playerId);
        if (was === undefined || r.connectedAt < was) firstAt.set(r.playerId, r.connectedAt);
        const row = at(dayOf(r.connectedAt), platformOf(r.playerId));
        foldMemorySession(row, r);
        const key = `${row.date}|${row.platform}`;
        const ids = seen.get(key) ?? new Set<string>();
        ids.add(r.playerId); seen.set(key, ids);
        const firstSeen = this.playersById.get(r.playerId)?.firstSeen;
        if (firstSeen !== undefined && dayOf(firstSeen) === row.date) {
          const nids = fresh.get(key) ?? new Set<string>();
          nids.add(r.playerId); fresh.set(key, nids);
        }
      }
      for (const [key, ids] of seen) byKey.get(key)!.players = ids.size;
      for (const [key, ids] of fresh) byKey.get(key)!.newPlayers = ids.size;
      // Each player once, on the day of their first session in the window; new by the breakdown's
      // rule (first seen in the window), as the Postgres twin counts them.
      for (const [playerId, at0] of firstAt) {
        const row = at(dayOf(at0), platformOf(playerId));
        row.firstPlayers += 1;
        const firstSeen = this.playersById.get(playerId)?.firstSeen;
        if (firstSeen !== undefined && firstSeen >= q.from) row.firstNewPlayers += 1;
      }
      for (const st of this.matchStatsByKey.values()) {
        if (q.serverId && st.serverId !== q.serverId) continue;
        const m = this.matchesById.get(st.matchId);
        if (!m || m.endedAt === null || m.startedAt < q.from || m.startedAt >= q.to) continue;
        foldMemoryRound(at(dayOf(m.startedAt), platformOf(st.playerId)), st);
      }
      return { rows: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)) };
    },
    playerMix: async (q: AnalyticsWindow): Promise<PlayerMix> => {
      const dayAfter = (iso: string) => new Date(Date.parse(iso) + 86_400_000).toISOString();
      const candidates = q.serverId
        ? [...new Set([...this.sessionsByPlayer.values()].flat()
            .filter((r) => r.serverId === q.serverId && r.connectedAt >= q.from && r.connectedAt < q.to)
            .map((r) => r.playerId))].map((id) => this.playersById.get(id)).filter(Boolean) as PlayerRow[]
        : [...this.playersById.values()].filter((p) => p.lastSeen >= q.from && p.lastSeen < q.to);
      let newPlayers = 0, returningPlayers = 0, newPlayersWhoCameBack = 0;
      for (const p of candidates) {
        if (p.firstSeen >= q.from) {
          newPlayers += 1;
          if (p.lastSeen > dayAfter(p.firstSeen)) newPlayersWhoCameBack += 1;
        } else returningPlayers += 1;
      }
      return { newPlayers, returningPlayers, newPlayersWhoCameBack };
    },
    matchesInWindow: async (q: AnalyticsWindow): Promise<MatchRow[]> =>
      [...this.matchesById.values()]
        .filter((m) => m.endedAt && m.startedAt >= q.from && m.startedAt < q.to && (!q.serverId || m.serverId === q.serverId))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 2000),
    concurrency: async (q: AnalyticsWindow): Promise<Concurrency> => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      const step = occupancySampleSec(days);
      const from = Date.parse(q.from), to = Date.parse(q.to);

      // Same span construction as Postgres: overlap rather than containment (a session that began
      // before the window was still players on the server during it), clipped to the window, with
      // the still-open ones running to its end. And the same two evidence rules (see the Postgres
      // twin): a span is believed for at most TORN_SESSION_SEC from its connect, and presence is
      // per PLAYER, never per session row.
      const tornMs = TORN_SESSION_SEC * 1000;
      const spans: { pid: string; a: number; b: number }[] = [];
      for (const r of [...this.sessionsByPlayer.values()].flat()) {
        if (q.serverId && r.serverId !== q.serverId) continue;
        const c = Date.parse(r.connectedAt);
        const a = Math.max(c, from), b = Math.min(Date.parse(r.disconnectedAt), c + tornMs, to);
        if (b > a) spans.push({ pid: r.playerId, a, b });
      }
      const openPlayers = new Set<string>();
      for (const [key, connectedAt] of this.openSessions.entries()) {
        // key is `${playerId}|${serverId}`.
        const pid = key.slice(0, key.indexOf("|"));
        const serverId = key.slice(key.indexOf("|") + 1);
        if (q.serverId && serverId !== q.serverId) continue;
        const c = Date.parse(connectedAt);
        const a = Math.max(c, from), b = Math.min(c + tornMs, to);
        if (b <= a) continue;
        spans.push({ pid, a, b });
        // "Online at the end" only while the row is younger than the torn cap there.
        if (c < to && c + tornMs >= to) openPlayers.add(pid);
      }

      // Occupancy at each sample instant: DISTINCT players, the way the SQL's LATERAL counts.
      // Peak and mean fold from this same per-instant pass (see blendMeasuredConcurrency) — the
      // exhaustive per-player sweep this replaced re-read every imported session on every call.
      const playersAt = new Map<number, Set<string>>();
      const stepMs = step * 1000;
      for (const s of spans) {
        for (let t = Math.ceil(s.a / stepMs) * stepMs; t < s.b; t += stepMs) {
          const set = playersAt.get(t) ?? new Set<string>();
          set.add(s.pid); playersAt.set(t, set);
        }
      }
      const countAt = new Map<number, number>();
      for (const [t, set] of playersAt) countAt.set(t, set.size);
      const openAtEnd = openPlayers.size;

      // MEASURED concurrency, mirroring the Postgres twin: earliest snapshot per server per
      // bucket, summed across servers, laid over the inference wherever it exists.
      const first = new Map<string, { k: number; ts: string; count: number }>();
      for (const r of this.rosterSnaps) {
        if (r.ts < q.from || r.ts >= q.to) continue;
        if (q.serverId && r.serverId !== q.serverId) continue;
        const k = Math.floor(Date.parse(r.ts) / stepMs);
        const key = `${r.serverId}|${k}`;
        const held = first.get(key);
        if (!held || r.ts < held.ts) first.set(key, { k, ts: r.ts, count: r.playerCount });
      }
      const measured = new Map<number, number>();
      for (const s of first.values()) measured.set(s.k * stepMs, (measured.get(s.k * stepMs) ?? 0) + s.count);
      let measuredMax: { c: number; at: string } | null = null;
      if (q.serverId) {
        for (const r of this.rosterSnaps) {
          if (r.ts < q.from || r.ts >= q.to || r.serverId !== q.serverId) continue;
          // Ties break to the EARLIEST instant, the same as the SQL's ORDER BY count DESC, ts —
          // or the two stores would date the same peak differently.
          if (!measuredMax || r.playerCount > measuredMax.c || (r.playerCount === measuredMax.c && r.ts < measuredMax.at)) {
            measuredMax = { c: r.playerCount, at: r.ts };
          }
        }
      }
      const blend = blendMeasuredConcurrency({
        from: q.from, to: q.to, stepSec: step,
        inferred: countAt,
        measured, measuredMax,
        inferredCap: q.serverId ? GAME_SLOT_CAP : null,
      });
      return {
        ...foldOccupancy(q, step, blend.counts, q.tz),
        peak: blend.peak,
        peakAt: blend.peakAt,
        average: blend.average,
        sampleSec: step,
        openAtEnd,
      };
    },
    earliest: async (serverId?: string): Promise<string | null> => {
      const on = (id: string | null | undefined) => !serverId || id === serverId;
      const stamps: string[] = [];
      for (const rows of this.sessionsByPlayer.values()) for (const r of rows) if (on(r.serverId)) stamps.push(r.connectedAt);
      for (const m of this.matchesById.values()) if (on(m.serverId)) stamps.push(m.startedAt);
      for (const r of this.rosterSnaps) if (on(r.serverId)) stamps.push(r.ts);
      for (const e of this.evts) if (on(e.serverId)) stamps.push(e.ts);
      if (!serverId) for (const a of this.auditLog) stamps.push(a.ts);
      const valid = stamps.filter((t) => Number.isFinite(Date.parse(t))).map((t) => new Date(t).toISOString());
      return valid.length ? valid.reduce((a, b) => (a < b ? a : b)) : null;
    },
    composition: async (q: AnalyticsWindow): Promise<RosterComposition> => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      const step = occupancySampleSec(days);
      const stepMs = step * 1000;
      // Same downsampling as the SQL's DISTINCT ON: keyed by server AND bucket, keeping the
      // earliest snapshot in each. Buckets floor on the epoch so both stores pick the same rows.
      const first = new Map<string, RosterSnapshotRow>();
      for (const r of this.rosterSnaps) {
        if (r.ts < q.from || r.ts >= q.to) continue;
        if (q.serverId && r.serverId !== q.serverId) continue;
        // Mirrors the SQL's game filter: only samples taken on the game the server runs now, so
        // the counts and the role labels the caller sends describe the same vocabulary.
        const serverGame = this.serversById.get(r.serverId)?.game ?? null;
        if (r.game !== null && serverGame !== null && r.game !== serverGame) continue;
        const key = `${r.serverId}|${Math.floor(Date.parse(r.ts) / stepMs)}`;
        const held = first.get(key);
        if (!held || r.ts < held.ts) first.set(key, r);
      }
      const sampled = [...first.values()].sort((a, b) => a.ts.localeCompare(b.ts));
      return foldComposition(sampled, step);
    },
    hourGrid: async (q: AnalyticsWindow & { serverId: string }, metric: HourMetric): Promise<DateHourRow[]> => {
      const tz = q.tz ?? "UTC";
      const inWindow = (ts: string) => ts >= q.from && ts < q.to;
      const snaps = this.rosterSnaps.filter((r) => r.serverId === q.serverId && inWindow(r.ts));
      const cells = new Map<string, number>();
      // The SQL's reading of a composition: a count where the sample holds a number, a list's
      // length or 0, and a side only where the sample has one.
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const side = (r: RosterSnapshotRow, id: string) => {
        const v = r.composition?.bySide?.[id];
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      };
      const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const averaged = (perSample: (r: RosterSnapshotRow) => number | null): DateHourRow[] => {
        const acc = new Map<string, { s: number; n: number }>();
        for (const r of snaps) {
          const v = perSample(r);
          if (v === null) continue;
          const k = localHourKey(r.ts, tz);
          const at = acc.get(k) ?? { s: 0, n: 0 };
          at.s += v; at.n += 1;
          acc.set(k, at);
        }
        for (const [k, at] of acc) cells.set(k, hourAverage(at.s, at.n));
        return foldHourGrid(q, tz, cells);
      };
      const counted = (stamps: string[]): DateHourRow[] => {
        for (const ts of stamps) { const k = localHourKey(ts, tz); cells.set(k, (cells.get(k) ?? 0) + 1); }
        return foldHourGrid(q, tz, cells, new Set(snaps.map((r) => localHourKey(r.ts, tz))));
      };
      switch (metric) {
        case "peak":
          for (const r of snaps) { const k = localHourKey(r.ts, tz); cells.set(k, Math.max(cells.get(k) ?? 0, r.playerCount)); }
          return foldHourGrid(q, tz, cells);
        case "queue": return averaged((r) => (typeof r.queueCount === "number" ? r.queueCount + (r.vipQueueCount ?? 0) : null));
        case "imbalance": return averaged((r) => {
          const a = num(side(r, "allies")?.players), x = num(side(r, "axis")?.players);
          return a === null || x === null ? null : Math.abs(a - x);
        });
        case "noLeader": return averaged((r) => {
          const a = side(r, "allies"), x = side(r, "axis");
          return a || x ? len(a?.noSlSquads) + len(x?.noSlSquads) : null;
        });
        case "unsquadded": return averaged((r) => {
          const a = side(r, "allies"), x = side(r, "axis");
          return a || x ? (num(a?.unsquadded) ?? 0) + (num(x?.unsquadded) ?? 0) : null;
        });
        case "arrivals":
          return counted([...this.sessionsByPlayer.values()].flat()
            .filter((r) => r.serverId === q.serverId && inWindow(r.connectedAt)).map((r) => r.connectedAt));
        default: {
          const kinds = HOUR_METRIC_KINDS[metric] ?? [];
          return counted(this.evts.filter((e) => e.serverId === q.serverId && inWindow(e.ts) && kinds.includes(e.kind)).map((e) => e.ts));
        }
      }
    },
    scoreTrends: async (q: AnalyticsWindow): Promise<ScoreTrends> => {
      // Same shape and same zone rule as the Postgres store; a dev without DATABASE_URL must see
      // the same chart, not a plausible-looking different one.
      const zone = q.tz ?? "UTC";
      const inWindow = [...this.matchesById.values()].filter(
        (m) => m.startedAt >= q.from && m.startedAt < q.to && (!q.serverId || m.serverId === q.serverId),
      );
      const byId = new Map(inWindow.map((m) => [m.id, m]));
      const rows = [...this.matchStatsByKey.values()].filter((r) => byId.has(r.matchId));

      const blank = () => ({ rounds: new Set<string>(), players: new Set<string>(), combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, vehicleKills: 0 });
      const perDay = new Map<string, ReturnType<typeof blank>>();
      const all = blank();
      const led = new Set<string>();
      for (const r of rows) {
        const m = byId.get(r.matchId)!;
        const p = zonedParts(new Date(m.startedAt), zone);
        const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
        const d = perDay.get(date) ?? blank();
        for (const acc of [d, all]) {
          acc.rounds.add(r.matchId);
          acc.players.add(r.playerId);
          acc.combat += r.combat; acc.offense += r.offense; acc.defense += r.defense; acc.support += r.support;
          acc.slSeconds += r.slSeconds; acc.vehicleKills += r.vehicleKills;
        }
        if (r.slSeconds > 0) led.add(r.playerId);
        perDay.set(date, d);
      }
      const shape = (a: ReturnType<typeof blank>) => ({
        rounds: a.rounds.size, players: a.players.size,
        combat: a.combat, offense: a.offense, defense: a.defense, support: a.support,
        slSeconds: a.slSeconds, vehicleKills: a.vehicleKills,
      });
      return {
        daily: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, a]) => ({ date, ...shape(a) })),
        totals: { ...shape(all), ledShare: all.players.size > 0 ? led.size / all.players.size : null },
      };
    },
    combat: async (q: AnalyticsWindow): Promise<CombatActivity> => {
      const rows = this.evts.filter((e) =>
        (e.kind === "evt.kill" || e.kind === "evt.teamkill")
        && e.ts >= q.from && e.ts < q.to && (!q.serverId || e.serverId === q.serverId));
      const isTk = (e: EvtRow) => e.kind === "evt.teamkill";

      const weaponRows = new Map<string, { weapon: string; kills: number; teamkills: number }>();
      const perDay = new Map<string, { date: string; kills: number; teamkills: number }>();
      const byHour = Array<number>(24).fill(0);
      const weekHour = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
      const perActor = new Map<string, { playerId: string; kills: number; teamkills: number }>();
      const killers = new Set<string>();
      const victims = new Set<string>();
      let kills = 0, teamkills = 0;

      // The same zone the Postgres store buckets in (AT TIME ZONE), so the two answer
      // identically. This block used to bucket in UTC regardless of q.tz — the one analytics
      // read that missed the zone pass — which put a non-UTC community's Saturday-evening kill
      // peak on Sunday morning whenever the panel ran without Postgres behind it.
      const zone = q.tz ?? "UTC";
      for (const e of rows) {
        const weapon = e.weapon || "Unknown";
        const w = weaponRows.get(weapon) ?? { weapon, kills: 0, teamkills: 0 };
        const p = zonedParts(new Date(e.ts), zone);
        const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
        const d = perDay.get(day) ?? { date: day, kills: 0, teamkills: 0 };
        if (isTk(e)) { w.teamkills += 1; d.teamkills += 1; teamkills += 1; }
        else {
          w.kills += 1; d.kills += 1; kills += 1;
          // The heatmap is kills only: team kills are rare enough that mixing them in would move
          // the whole ramp without ever being visible.
          const hour = Math.floor(p.minutes / 60);
          const dow = WEEKDAY_ORDER.indexOf(p.weekday);
          byHour[hour] = (byHour[hour] ?? 0) + 1;
          const row = weekHour[dow]!;
          row[hour] = (row[hour] ?? 0) + 1;
        }
        weaponRows.set(weapon, w);
        perDay.set(day, d);
        if (e.actorPlayerId) {
          killers.add(e.actorPlayerId);
          const a = perActor.get(e.actorPlayerId) ?? { playerId: e.actorPlayerId, kills: 0, teamkills: 0 };
          if (isTk(e)) a.teamkills += 1; else a.kills += 1;
          perActor.set(e.actorPlayerId, a);
        }
        if (e.victimPlayerId) victims.add(e.victimPlayerId);
      }

      // Same read-time name resolution as Postgres: current name wins, the stored one is the
      // fallback for a player we no longer have a row for.
      const nameOf = (playerId: string) => {
        const current = this.playersById.get(playerId)?.name;
        if (current) return current;
        return rows.find((e) => e.actorPlayerId === playerId)?.actorName ?? "Unknown";
      };

      // Mirrors the Postgres join exactly, INCLUDING its inner-join semantics: a round with no
      // events in the window contributes nothing, so a map nobody died on never appears as a row
      // of zeroes. (The two stores disagreed on this until a parity run caught it.)
      const byMap = new Map<string, { map: string; kills: number; teamkills: number }>();
      for (const m of this.matchesById.values()) {
        if (q.serverId && m.serverId !== q.serverId) continue;
        const end = m.endedAt ?? new Date().toISOString();
        const inRound = rows.filter((e) => e.serverId === m.serverId && e.ts >= m.startedAt && e.ts < end);
        if (!inRound.length) continue;
        const key = m.map ?? "Unknown";
        const acc = byMap.get(key) ?? { map: key, kills: 0, teamkills: 0 };
        for (const e of inRound) { if (isTk(e)) acc.teamkills += 1; else acc.kills += 1; }
        byMap.set(key, acc);
      }

      return {
        totals: { kills, teamkills, killers: killers.size, victims: victims.size },
        byWeapon: [...weaponRows.values()].sort((a, b) => (b.kills + b.teamkills) - (a.kills + a.teamkills)),
        daily: [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
        weekHour,
        byHour,
        topKillers: [...perActor.values()]
          .filter((a) => a.kills > 0)
          .sort((a, b) => b.kills - a.kills).slice(0, 25)
          .map((a) => ({ playerId: a.playerId, name: nameOf(a.playerId), kills: a.kills })),
        topTeamkillers: [...perActor.values()]
          .filter((a) => a.teamkills > 0)
          .sort((a, b) => b.teamkills - a.teamkills).slice(0, 25)
          .map((a) => ({ playerId: a.playerId, name: nameOf(a.playerId), teamkills: a.teamkills, kills: a.kills })),
        byMap: [...byMap.values()].sort((a, b) => b.kills - a.kills),
      };
    },
  };

  featurePresets = {
    list: async (feature: string): Promise<FeaturePresetRow[]> =>
      [...this.featurePresetRows.values()].filter((p) => p.feature === feature)
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    get: async (feature: string, name: string): Promise<FeaturePresetRow | null> =>
      [...this.featurePresetRows.values()].find((p) => p.feature === feature && p.name.toLowerCase() === name.toLowerCase()) ?? null,
    save: async (input: { feature: string; name: string; config: Record<string, unknown>; game?: string | null; createdByName: string }): Promise<FeaturePresetRow> => {
      const existing = [...this.featurePresetRows.values()].find((p) => p.feature === input.feature && p.name.toLowerCase() === input.name.toLowerCase());
      const row: FeaturePresetRow = {
        id: existing?.id ?? randomUUID(), feature: input.feature, name: input.name, config: input.config,
        game: input.game ?? null,
        createdByName: input.createdByName, updatedAt: new Date().toISOString(),
      };
      this.featurePresetRows.set(row.id, row);
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.featurePresetRows.delete(id),
  };

  rosterSnapshots = {
    record: async (input: RosterSnapshotInput): Promise<void> => {
      // Mirrors the unique index on (server_id, ts): a retrying sampler re-writing the same instant
      // must not double-count a population.
      if (this.rosterSnaps.some((r) => r.serverId === input.serverId && r.ts === input.ts)) return;
      this.rosterSnaps.push({ id: `rs-${++this.rosterSnapSeq}`, ...input,
        // Stamped from the server as the sample is written — mirrors the SQL insert.
        game: this.serversById.get(input.serverId)?.game ?? null,
        composition: input.composition ?? {},
        mapName: input.mapName ?? null, gameMode: input.gameMode ?? null,
        alliedScore: input.alliedScore ?? null, axisScore: input.axisScore ?? null,
        queueCount: wholeOrNull(input.queueCount), vipQueueCount: wholeOrNull(input.vipQueueCount) });
    },
    list: async (q: AnalyticsWindow): Promise<RosterSnapshotRow[]> =>
      this.rosterSnaps
        .filter((r) => r.ts >= q.from && r.ts < q.to && (!q.serverId || r.serverId === q.serverId))
        .sort((a, b) => a.ts.localeCompare(b.ts) || a.serverId.localeCompare(b.serverId)),
    scoreTimeline: async (serverId: string, fromIso: string, toIso: string): Promise<{ ts: string; alliedScore: number; axisScore: number }[]> =>
      this.rosterSnaps
        .filter((r) => r.serverId === serverId && r.ts >= fromIso && r.ts < toIso
          && typeof r.alliedScore === "number" && typeof r.axisScore === "number")
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .map((r) => ({ ts: r.ts, alliedScore: r.alliedScore as number, axisScore: r.axisScore as number })),
    latest: async (serverId: string): Promise<RosterSnapshotRow | null> =>
      this.rosterSnaps
        .filter((r) => r.serverId === serverId)
        .sort((a, b) => b.ts.localeCompare(a.ts))[0] ?? null,
  };

  layouts = {
    get: async (surface: string, scopeType: LayoutScope, scopeId: string): Promise<LayoutRow | null> =>
      this.layoutsByKey.get(`${scopeType}:${scopeId}:${surface}`) ?? null,
    set: async (surface: string, scopeType: LayoutScope, scopeId: string, config: Record<string, unknown>): Promise<LayoutRow> => {
      const key = `${scopeType}:${scopeId}:${surface}`;
      const row: LayoutRow = { id: this.layoutsByKey.get(key)?.id ?? randomUUID(), scopeType, scopeId, surface, config, updatedAt: new Date().toISOString() };
      this.layoutsByKey.set(key, row);
      return row;
    },
    remove: async (surface: string, scopeType: LayoutScope, scopeId: string): Promise<boolean> =>
      this.layoutsByKey.delete(`${scopeType}:${scopeId}:${surface}`),
    countForScope: async (scopeType: LayoutScope, scopeId: string): Promise<number> =>
      [...this.layoutsByKey.values()].filter((r) => r.scopeType === scopeType && r.scopeId === scopeId).length,
  };

  ruleSections = {
    list: async (): Promise<RuleSectionRow[]> => [...this.ruleSectionsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    create: async (name: string): Promise<RuleSectionRow> => {
      const clean = name.trim();
      if ([...this.ruleSectionsById.values()].some((x) => x.name.toLowerCase() === clean.toLowerCase())) throw new RuleSectionNameTaken(clean);
      const now = new Date().toISOString();
      const row: RuleSectionRow = { id: randomUUID(), name: clean, enabled: true, createdAt: now, updatedAt: now };
      this.ruleSectionsById.set(row.id, row);
      return row;
    },
    rename: async (id: string, name: string): Promise<RuleSectionRow | null> => {
      const row = this.ruleSectionsById.get(id);
      if (!row) return null;
      const clean = name.trim();
      if ([...this.ruleSectionsById.values()].some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new RuleSectionNameTaken(clean);
      row.name = clean;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    setEnabled: async (id: string, enabled: boolean): Promise<RuleSectionRow | null> => {
      const row = this.ruleSectionsById.get(id);
      if (!row) return null;
      row.enabled = enabled;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string): Promise<boolean> => {
      if (!this.ruleSectionsById.delete(id)) return false;
      // ON DELETE SET NULL: the rules stay, on no section.
      for (const r of this.rulesById.values()) if (r.sectionId === id) r.sectionId = null;
      return true;
    },
  };

  configVersions = {
    record: async (input: NewConfigVersion): Promise<ConfigVersionRow> => {
      const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)) as T);
      const row = { ...input, before: clone(input.before), after: clone(input.after), id: randomUUID(), createdAt: new Date().toISOString(), seq: ++this.configVersionSeq };
      this.configVersionRows.push(row);
      const mine = this.configVersionRows.filter((r) => r.kind === input.kind && r.targetId === input.targetId);
      if (mine.length > CONFIG_VERSIONS_KEPT) {
        const drop = new Set(mine.slice(0, mine.length - CONFIG_VERSIONS_KEPT).map((r) => r.id));
        this.configVersionRows = this.configVersionRows.filter((r) => !drop.has(r.id));
      }
      const { seq: _seq, ...out } = row;
      return out;
    },
    list: async (kind: ConfigVersionKind, targetId: string, limit = CONFIG_VERSIONS_KEPT): Promise<ConfigVersionRow[]> =>
      this.configVersionRows.filter((r) => r.kind === kind && r.targetId === targetId)
        .sort((a, b) => b.seq - a.seq).slice(0, limit).map(({ seq: _seq, ...r }) => r),
    get: async (id: string): Promise<ConfigVersionRow | null> => {
      const hit = this.configVersionRows.find((r) => r.id === id);
      if (!hit) return null;
      const { seq: _seq, ...r } = hit;
      return r;
    },
    deletions: async (kind: ConfigVersionKind, limit = 50): Promise<ConfigVersionRow[]> => {
      const latest = new Map<string, ConfigVersionRow & { seq: number }>();
      for (const r of this.configVersionRows) if (r.kind === kind && r.change === "delete") latest.set(r.targetId, r);
      return [...latest.values()].sort((a, b) => b.seq - a.seq).slice(0, limit).map(({ seq: _seq, ...r }) => r);
    },
  };

  /** Stamp a stored rule with its section's master switch as it stands now — read, like the
   *  Postgres join, on every way a rule comes back out. */
  private ruleRead(row: RuleRow): RuleRow {
    row.sectionOff = row.sectionId !== null && this.ruleSectionsById.get(row.sectionId)?.enabled === false;
    return row;
  }

  enforcerRules = {
    list: async (): Promise<RuleRow[]> => [...this.rulesById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => this.ruleRead(r)),
    get: async (id: string): Promise<RuleRow | null> => {
      const row = this.rulesById.get(id);
      return row ? this.ruleRead(row) : null;
    },
    create: async (input: NewRule): Promise<RuleRow> => {
      const now = new Date().toISOString();
      if (input.id && this.rulesById.has(input.id)) throw new Error("duplicate key: a rule with that id exists");
      const row: RuleRow = {
        id: input.id ?? randomUUID(),
        name: input.name,
        enabled: input.enabled ?? true,
        serverId: input.serverId ?? null,
        eventKind: input.eventKind,
        match: input.match ?? null,
        threshold: input.threshold ?? 1,
        windowSec: input.windowSec ?? 0,
        action: input.action,
        reason: input.reason ?? null,
        hours: input.hours ?? null,
        delaySec: input.delaySec ?? 0,
        vipMinutes: input.vipMinutes ?? 10,
        vipCooldownMinutes: input.vipCooldownMinutes ?? 60,
        requireRoleIds: input.requireRoleIds ?? [],
        immuneTags: input.immuneTags ?? [],
        immuneRoleIds: input.immuneRoleIds ?? [],
        immuneLevel: input.immuneLevel ?? 0,
        dryRun: input.dryRun ?? false,
        escalateActions: input.escalateActions ?? [],
        escalateResetMinutes: input.escalateResetMinutes ?? 120,
        alertEnabled: input.alertEnabled ?? true,
        alertChannelId: input.alertChannelId ?? null,
        params: input.params ?? null,
        activeHours: input.activeHours ?? null,
        playersMin: input.playersMin ?? 0,
        playersMax: input.playersMax ?? 0,
        breakerLimit: input.breakerLimit ?? 10,
        matchMinutesMin: input.matchMinutesMin ?? 0,
        matchMinutesMax: input.matchMinutesMax ?? 0,
        countPerMatch: input.countPerMatch ?? false,
        requireTags: input.requireTags ?? [],
        capCount: input.capCount ?? 0,
        capPeriod: input.capPeriod ?? "day",
        actionTag: input.actionTag ?? null,
        points: input.points ?? 0,
        sectionId: input.sectionId && this.ruleSectionsById.has(input.sectionId) ? input.sectionId : null,
        sectionOff: false,
        pausedUntil: null,
        pauseReason: null,
        pausedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rulesById.set(row.id, row);
      return this.ruleRead(row);
    },
    update: async (id: string, patch: RulePatch): Promise<RuleRow | null> => {
      const row = this.rulesById.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      // The foreign key's answer to a section that does not exist (Postgres refuses the write).
      if (patch.sectionId !== undefined && patch.sectionId !== null && !this.ruleSectionsById.has(patch.sectionId)) throw new Error("no such rule section");
      row.updatedAt = new Date().toISOString();
      return this.ruleRead(row);
    },
    setSection: async (ruleIds: string[], sectionId: string | null): Promise<number> => {
      if (sectionId !== null && !this.ruleSectionsById.has(sectionId)) throw new Error("no such rule section");
      let n = 0;
      for (const id of new Set(ruleIds)) {
        const row = this.rulesById.get(id);
        if (!row) continue;
        row.sectionId = sectionId;
        n += 1;
      }
      return n;
    },
    setPause: async (id: string, pause: { until: string; reason: string; by: string } | null): Promise<RuleRow | null> => {
      const row = this.rulesById.get(id);
      if (!row) return null;
      row.pausedUntil = pause ? new Date(pause.until).toISOString() : null;
      row.pauseReason = pause?.reason ?? null;
      row.pausedBy = pause?.by ?? null;
      return this.ruleRead(row);
    },
    remove: async (id: string): Promise<boolean> => {
      // Mirrors the Postgres ON DELETE CASCADE: a rule's cooldowns die with it, so a rebuilt rule
      // starts everyone clean rather than inheriting the deleted one's memory.
      for (const k of [...this.vipGrantAt.keys()]) if (k.startsWith(`${id}|`)) this.vipGrantAt.delete(k);
      this.ruleFirings = this.ruleFirings.filter((f) => f.ruleId !== id);
      for (const k of [...this.ruleOccurrences]) if (k.startsWith(`${id}|`)) this.ruleOccurrences.delete(k);
      return this.rulesById.delete(id);
    },
    activity: async (since: string): Promise<Map<string, { lastFiredAt: string; count: number }>> => {
      const out = new Map<string, { lastFiredAt: string; count: number }>();
      for (const a of this.auditLog) {
        if (!a.action.startsWith("enforcer.") || a.ts < since) continue;
        const ruleId = (a.data as { ruleId?: string } | null)?.ruleId;
        if (!ruleId) continue;
        const cur = out.get(ruleId);
        out.set(ruleId, { lastFiredAt: cur && cur.lastFiredAt > a.ts ? cur.lastFiredAt : a.ts, count: (cur?.count ?? 0) + 1 });
      }
      return out;
    },
    recordCheck: async (ruleId: string, serverId: string, summary: RuleCheckSummary): Promise<void> => {
      if (!this.rulesById.has(ruleId)) return; // the FK: a deleted rule keeps no status
      const key = `${ruleId}|${serverId}`;
      const cur = this.ruleStatus.get(key) ?? { ruleId, serverId, checkedAt: null, check: null, skippedAt: null, skipReason: null, skipPlayer: null };
      this.ruleStatus.set(key, { ...cur, checkedAt: new Date().toISOString(), check: summary });
    },
    recordSkip: async (ruleId: string, serverId: string, reason: string, playerName: string | null): Promise<void> => {
      if (!this.rulesById.has(ruleId)) return;
      const key = `${ruleId}|${serverId}`;
      const cur = this.ruleStatus.get(key) ?? { ruleId, serverId, checkedAt: null, check: null, skippedAt: null, skipReason: null, skipPlayer: null };
      this.ruleStatus.set(key, { ...cur, skippedAt: new Date().toISOString(), skipReason: reason.slice(0, 500), skipPlayer: playerName });
    },
    statuses: async (): Promise<RuleStatusRow[]> =>
      [...this.ruleStatus.values()].filter((r) => this.rulesById.has(r.ruleId)).map((r) => ({ ...r })),
    firingCount: async (ruleId: string, subjectId: string, since: string | null, dryRun: boolean): Promise<number> =>
      this.ruleFirings.filter((f) => f.ruleId === ruleId && f.playerId === subjectId && f.dryRun === dryRun && (since === null || f.firedAt >= since)).length,
    recordFiring: async (ruleId: string, subjectId: string, dryRun: boolean): Promise<void> => {
      if (!this.rulesById.has(ruleId)) return; // the FK: a deleted rule counts nothing
      this.ruleFirings.push({ ruleId, playerId: subjectId, dryRun, firedAt: new Date().toISOString() });
    },
    claimOccurrence: async (ruleId: string, occurrence: string): Promise<boolean> => {
      if (!this.rulesById.has(ruleId)) return false; // the FK: a deleted rule claims nothing
      const key = `${ruleId}|${occurrence}`;
      if (this.ruleOccurrences.has(key)) return false;
      this.ruleOccurrences.add(key);
      return true;
    },
    lastVipGrantAt: async (ruleId: string, serverId: string, playerId: string): Promise<string | null> =>
      this.vipGrantAt.get(`${ruleId}|${serverId}|${playerId}`) ?? null,
    recordVipGrant: async (ruleId: string, serverId: string, playerId: string): Promise<void> => {
      this.vipGrantAt.set(`${ruleId}|${serverId}|${playerId}`, new Date().toISOString());
    },
  };

  /**
   * Mirror of the Postgres CURRENT_NAME join: a row that keeps its own copy of a player's name
   * shows the CURRENT one, falling back to the stored copy for players we have never seen. Both
   * stores have to answer this the same way or a behaviour only shows up in production.
   */
  private withCurrentName<T extends { playerId: string; playerName: string | null }>(row: T): T {
    // Keyed on the PLATFORM id, matching the Postgres join: these rows hold the raw game id, not
    // our uuid, because an entry can be made for a player who has never joined.
    const current = this.playersByPlatform.get(row.playerId)?.name;
    // Always a copy, like a row read from Postgres: a caller holding one never sees a later
    // write change it underneath (the hold the perk began after a grant read its row, say).
    return current ? { ...row, playerName: current } : { ...row };
  }

  vips = {
    list: async (serverId?: string): Promise<VipRow[]> => {
      const all = [...this.vipsByKey.values()];
      const rows = serverId ? all.filter((v) => v.serverId === serverId) : all;
      return rows.map((v) => this.withCurrentName(v)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    listByPlayer: async (playerId: string): Promise<VipRow[]> => {
      return [...this.vipsByKey.values()]
        .filter((v) => v.playerId === playerId)
        .map((v) => this.withCurrentName(v))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    get: async (serverId: string, playerId: string): Promise<VipRow | null> => {
      const row = this.vipsByKey.get(`${serverId}|${playerId}`);
      return row ? this.withCurrentName(row) : null;
    },
    upsert: async (input: NewVip): Promise<VipRow & { endedHold?: VipGroupHold | null }> => {
      const key = `${input.serverId}|${input.playerId}`;
      const now = new Date().toISOString();
      const existing = this.vipsByKey.get(key);
      // A permanent grant keeps its null expiration unless the caller SAYS it is replacing it —
      // see NewVip.replacePermanent for why this floor lives in the store. A grant a group perk
      // holds stays permanent whatever the write says, unless a person grants permanent VIP
      // outright (endsGroupHold), which drops the hold; a dated write on it goes to the frozen
      // balance, the larger of the two (see NewVip.endsGroupHold).
      const held = !!existing?.groupHold && input.endsGroupHold !== true;
      // A date in CRCON's year-3000 "never expires" range is stored as permanent.
      const written = storedVipExpiration(input.expiration);
      const keepPermanent = held || (existing?.expiration === null && !existing?.groupHold && written !== null && !input.replacePermanent);
      // A DATED grant keeps the later of its date and the written one unless the write may shorten
      // it (NewVip.mayShorten, or replacePermanent's exact set): automation only ever adds time.
      const keepLater = !held && !existing?.groupHold && existing?.expiration != null && written !== null
        && Date.parse(written) < Date.parse(existing.expiration) && input.mayShorten !== true && input.replacePermanent !== true;
      // The time a dated write gives, on the grant's own clock: a banked VIP timeout stopped it at
      // its start (NewVip.thawsPause: the timeout's end, already measured from now).
      const frozenAt = existing?.pauseMode === "banked" && existing.pausedUntil !== null && existing.pausedAt && !input.thawsPause ? Date.parse(existing.pausedAt) : Date.parse(now);
      const hold = held && written
        ? { ...existing!.groupHold!, bankedMs: Math.max(existing!.groupHold!.bankedMs, Math.floor(Date.parse(written) - frozenAt)) }
        : held ? existing!.groupHold : null;
      const row: VipRow = {
        id: existing?.id ?? randomUUID(),
        serverId: input.serverId,
        playerId: input.playerId,
        playerName: input.playerName ?? existing?.playerName ?? null,
        // A write the floor turned away leaves the grant as it was, its note included (a staff
        // "paid" marker is not replaced by the note of a grant that never landed) — but a note a
        // person typed for it lands (NewVip.typedNote).
        comment: held || ((keepPermanent || keepLater) && !input.typedNote) ? existing!.comment : input.comment ?? existing?.comment ?? null,
        expiration: keepPermanent ? null : keepLater ? existing!.expiration : written,
        // A grant/extension never touches the pause — accumulating while paused is the contract.
        pausedUntil: existing?.pausedUntil ?? null,
        pauseReason: existing?.pauseReason ?? null,
        pausedBy: existing?.pausedBy ?? null,
        pauseMode: existing?.pauseMode ?? null,
        pausedAt: existing?.pausedAt ?? null,
        groupHold: hold,
        createdByUserId: existing?.createdByUserId ?? input.createdByUserId ?? null,
        createdByName: existing?.createdByName ?? input.createdByName,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.vipsByKey.set(key, row);
      return { ...row, endedHold: input.endsGroupHold === true && existing?.groupHold ? existing.groupHold : null };
    },
    importOne: async (input: NewVip): Promise<{ row: VipRow; inserted: boolean }> => {
      // The archive never overrules a live grant — see the contract on Repository.vips.importOne.
      const key = `${input.serverId}|${input.playerId}`;
      const existing = this.vipsByKey.get(key);
      if (existing) return { row: existing, inserted: false };
      return { row: await this.vips.upsert(input), inserted: true };
    },
    remove: async (serverId: string, playerId: string): Promise<boolean> => this.vipsByKey.delete(`${serverId}|${playerId}`),
    removeExpired: async (serverId: string, playerId: string): Promise<boolean> => {
      const key = `${serverId}|${playerId}`;
      const v = this.vipsByKey.get(key);
      if (!v || v.groupHold || v.expiration === null || v.expiration > new Date().toISOString()) return false;
      return this.vipsByKey.delete(key);
    },
    updateTimedExpiration: async (serverId: string, playerId: string, expiration: string): Promise<VipRow | null> => {
      const v = this.vipsByKey.get(`${serverId}|${playerId}`);
      if (!v || v.groupHold || v.expiration === null) return null;
      v.expiration = new Date(expiration).toISOString();
      v.updatedAt = new Date().toISOString();
      return this.withCurrentName(v);
    },
    removeTimed: async (serverId: string, playerId: string): Promise<boolean> => {
      const key = `${serverId}|${playerId}`;
      const v = this.vipsByKey.get(key);
      if (!v || v.groupHold || v.expiration === null) return false;
      return this.vipsByKey.delete(key);
    },
    // Banked pauses freeze the meter, so those rows are invisible to the expiry sweep (the
    // Postgres store applies the same rule in SQL).
    expired: async (nowIso: string): Promise<VipRow[]> =>
      [...this.vipsByKey.values()].filter((v) => v.expiration !== null && v.expiration <= nowIso && !(v.pauseMode === "banked" && v.pausedUntil !== null)),
    setPause: async (serverId: string, playerId: string, pause: VipPause | null): Promise<VipRow | null> => {
      const key = `${serverId}|${playerId}`;
      const row = this.vipsByKey.get(key);
      if (!row) return null;
      row.pausedUntil = pause?.until ?? null;
      row.pauseReason = pause?.reason ?? null;
      row.pausedBy = pause?.by ?? null;
      row.pauseMode = pause ? (pause.mode ?? "running") : null;
      row.pausedAt = pause ? (pause.at ?? new Date().toISOString()) : null;
      row.updatedAt = new Date().toISOString();
      return { ...row };
    },
    pauseLapsed: async (nowIso: string): Promise<VipRow[]> =>
      [...this.vipsByKey.values()].filter((v) => v.pausedUntil !== null && v.pausedUntil <= nowIso).map((v) => ({ ...v })),
    startGroupHold: async (input: { serverId: string; playerId: string; playerName?: string | null; groups: VipGroupHoldSource[]; createdByName: string; whilePerks?: boolean }): Promise<VipRow | null> => {
      const key = `${input.serverId}|${input.playerId}`;
      const existing = this.vipsByKey.get(key);
      // The Postgres store's check: every group named still carries a perk with that severance.
      if (input.whilePerks && !input.groups.every((g) => {
        const perk = this.playerGroupsById.get(g.id)?.vipPerk;
        return !!perk && Math.round(perk.severanceMinutes || 0) === Math.round(g.severanceMinutes || 0);
      })) return null;
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const groups = input.groups.map((g) => ({ ...g }));
      if (existing) {
        if (existing.groupHold) {
          existing.groupHold = { ...existing.groupHold, groups };
        } else {
          // Already permanent and nobody's hold: theirs, not the group's.
          if (existing.expiration === null) return null;
          const from = existing.pauseMode === "banked" && existing.pausedUntil !== null && existing.pausedAt ? Date.parse(existing.pausedAt) : nowMs;
          existing.groupHold = { since: now, bankedMs: Math.max(0, Math.floor(Date.parse(existing.expiration) - from)), groups };
          existing.expiration = null;
        }
        if (input.playerName) existing.playerName = input.playerName;
        existing.updatedAt = now;
        return this.withCurrentName(existing);
      }
      const row: VipRow = {
        id: randomUUID(), serverId: input.serverId, playerId: input.playerId, playerName: input.playerName ?? null,
        comment: `group: ${groups.map((g) => g.name).filter(Boolean).join(", ") || "perk"}`, expiration: null,
        pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null,
        groupHold: { since: now, bankedMs: 0, groups },
        createdByUserId: null, createdByName: input.createdByName, createdAt: now, updatedAt: now,
      };
      this.vipsByKey.set(key, row);
      return this.withCurrentName(row);
    },
    setGroupHoldSources: async (serverId: string, playerId: string, groups: VipGroupHoldSource[], expect?: VipGroupHoldSource[]): Promise<VipRow | null> => {
      const row = this.vipsByKey.get(`${serverId}|${playerId}`);
      if (!row?.groupHold) return null;
      // The same comparisons as the Postgres store: which groups, and each one's severance — and
      // every group named still carrying a perk with the severance being written.
      const sig = (gs: VipGroupHoldSource[]) => JSON.stringify(gs.map((g) => [g.id, Math.round(g.severanceMinutes || 0)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      if (expect && sig(row.groupHold.groups) !== sig(expect)) return null;
      if (expect && !groups.every((g) => {
        const perk = this.playerGroupsById.get(g.id)?.vipPerk;
        return !!perk && Math.round(perk.severanceMinutes || 0) === Math.round(g.severanceMinutes || 0);
      })) return null;
      row.groupHold = { ...row.groupHold, groups: groups.map((g) => ({ ...g })) };
      row.updatedAt = new Date().toISOString();
      return this.withCurrentName(row);
    },
    bankGroupHold: async (serverId: string, playerId: string, change: { addMs?: number; atLeastMs?: number }): Promise<VipRow | null> => {
      const row = this.vipsByKey.get(`${serverId}|${playerId}`);
      if (!row?.groupHold) return null;
      const add = Math.max(0, Math.round(change.addMs ?? 0));
      const atLeast = Math.max(0, Math.round(change.atLeastMs ?? 0));
      row.groupHold = { ...row.groupHold, bankedMs: Math.max(row.groupHold.bankedMs + add, atLeast) };
      row.updatedAt = new Date().toISOString();
      return this.withCurrentName(row);
    },
    cutGroupHold: async (serverId: string, playerId: string, change: { cutMs?: number; all?: boolean }): Promise<{ row: VipRow; removedMs: number } | null> => {
      const row = this.vipsByKey.get(`${serverId}|${playerId}`);
      if (!row?.groupHold) return null;
      const before = row.groupHold.bankedMs;
      const after = change.all === true ? 0 : Math.max(0, before - Math.max(0, Math.round(change.cutMs ?? 0)));
      row.groupHold = { ...row.groupHold, bankedMs: after };
      row.updatedAt = new Date().toISOString();
      return { row: this.withCurrentName(row), removedMs: before - after };
    },
    endGroupHold: async (serverId: string, playerId: string, expiration: string, expect?: { bankedMs: number; severanceMinutes: number }): Promise<VipRow | null> => {
      const row = this.vipsByKey.get(`${serverId}|${playerId}`);
      if (!row?.groupHold) return null;
      if (expect) {
        const severance = row.groupHold.groups.reduce((m, g) => Math.max(m, g.severanceMinutes || 0), 0);
        if (Math.round(row.groupHold.bankedMs) !== Math.round(expect.bankedMs) || severance !== Math.round(expect.severanceMinutes)) return null;
      }
      const now = new Date().toISOString();
      row.groupHold = null;
      // A balance banked off a year-3000 row hands back a date in that range: permanent, stored so.
      row.expiration = storedVipExpiration(expiration);
      if (row.pauseMode === "banked" && row.pausedUntil !== null) row.pausedAt = now;
      row.updatedAt = now;
      return this.withCurrentName(row);
    },
    groupHeld: async (): Promise<VipRow[]> =>
      [...this.vipsByKey.values()].filter((v) => v.groupHold).map((v) => this.withCurrentName(v)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    setGroupSeverance: async (groupId: string, minutes: number): Promise<number> => {
      const m = Math.max(0, Math.round(minutes));
      let n = 0;
      for (const v of this.vipsByKey.values()) {
        if (!v.groupHold?.groups.some((g) => g.id === groupId)) continue;
        v.groupHold = { ...v.groupHold, groups: v.groupHold.groups.map((g) => (g.id === groupId ? { ...g, severanceMinutes: m } : g)) };
        v.updatedAt = new Date().toISOString();
        n += 1;
      }
      return n;
    },
  };

  playerTriggers = {
    listArmed: async (): Promise<PlayerTriggerRow[]> =>
      [...this.playerTriggersById.values()].filter((t) => t.enabled && t.disarmedAt === null).map((t) => ({ ...t })),
    listAll: async (limit = 200, serverIds?: string[]): Promise<PlayerTriggerRow[]> => {
      const armed = (t: PlayerTriggerRow) => (t.enabled && t.disarmedAt === null ? 1 : 0);
      // Narrow BEFORE the cap, exactly as the SQL store does.
      const allowed = serverIds ? new Set(serverIds) : null;
      return [...this.playerTriggersById.values()]
        .filter((t) => !allowed || t.serverId === null || allowed.has(t.serverId))
        .sort((a, b) => armed(b) - armed(a) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit).map((t) => ({ ...t }));
    },
    listByPlayer: async (playerId: string): Promise<PlayerTriggerRow[]> =>
      [...this.playerTriggersById.values()].filter((t) => t.playerId === playerId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => ({ ...t })),
    get: async (id: string): Promise<PlayerTriggerRow | null> => {
      const t = this.playerTriggersById.get(id);
      return t ? { ...t } : null;
    },
    create: async (input: NewPlayerTrigger): Promise<PlayerTriggerRow> => {
      const row: PlayerTriggerRow = {
        id: randomUUID(),
        playerId: input.playerId,
        playerName: input.playerName ?? null,
        serverId: input.serverId ?? null,
        event: input.event,
        steps: input.steps.map((st) => ({
          action: st.action, message: st.message ?? null,
          hours: st.hours || 0, points: st.points || 0, delaySec: st.delaySec || 0,
        })),
        fireOnce: input.fireOnce ?? true,
        enabled: true,
        note: input.note ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByName: input.createdByName,
        createdAt: new Date().toISOString(),
        firedCount: 0,
        lastFiredAt: null,
        disarmedAt: null,
        params: structuredClone(input.params ?? {}),
        updatedAt: null,
        updatedByName: null,
      };
      this.playerTriggersById.set(row.id, row);
      return { ...row };
    },
    update: async (id: string, patch: { enabled?: boolean; note?: string | null }): Promise<PlayerTriggerRow | null> => {
      const t = this.playerTriggersById.get(id);
      if (!t) return null;
      if (patch.enabled !== undefined) t.enabled = patch.enabled;
      if (patch.note !== undefined) t.note = patch.note;
      return { ...t };
    },
    edit: async (id: string, def: PlayerTriggerEdit): Promise<PlayerTriggerRow | null> => {
      const t = this.playerTriggersById.get(id);
      if (!t) return null;
      t.serverId = def.serverId;
      t.event = def.event;
      t.params = structuredClone(def.params ?? {});
      t.steps = def.steps.map((st) => ({ action: st.action, message: st.message ?? null, hours: st.hours || 0, points: st.points || 0, delaySec: st.delaySec || 0 }));
      t.fireOnce = def.fireOnce;
      t.note = def.note;
      t.updatedAt = new Date().toISOString();
      t.updatedByName = def.editedByName;
      if (def.rearm) t.disarmedAt = null;
      return { ...t, steps: t.steps.map((st) => ({ ...st })) };
    },
    recordFire: async (id: string, disarm: boolean, at: string): Promise<PlayerTriggerRow | null> => {
      const t = this.playerTriggersById.get(id);
      if (!t) return null;
      t.firedCount += 1;
      t.lastFiredAt = at;
      if (disarm) t.disarmedAt = at;
      return { ...t };
    },
    remove: async (id: string): Promise<boolean> => this.playerTriggersById.delete(id),
  };

  consoleAdmins = {
    list: async (serverId?: string): Promise<ConsoleAdminRow[]> => {
      const all = [...this.consoleAdminsByKey.values()];
      const rows = serverId ? all.filter((a) => a.serverId === serverId) : all;
      return rows.map((a) => this.withCurrentName(a)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    get: async (serverId: string, playerId: string): Promise<ConsoleAdminRow | null> => {
      const row = this.consoleAdminsByKey.get(`${serverId}|${playerId}`);
      return row ? this.withCurrentName(row) : null;
    },
    upsert: async (input: NewConsoleAdmin): Promise<ConsoleAdminRow> => {
      const key = `${input.serverId}|${input.playerId}`;
      const now = new Date().toISOString();
      const existing = this.consoleAdminsByKey.get(key);
      const row: ConsoleAdminRow = {
        id: existing?.id ?? randomUUID(),
        serverId: input.serverId,
        playerId: input.playerId,
        playerName: input.playerName ?? existing?.playerName ?? null,
        adminGroup: input.adminGroup,
        comment: input.comment ?? existing?.comment ?? null,
        expiration: input.expiration ?? null,
        createdByUserId: existing?.createdByUserId ?? input.createdByUserId ?? null,
        createdByName: existing?.createdByName ?? input.createdByName,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.consoleAdminsByKey.set(key, row);
      return row;
    },
    remove: async (serverId: string, playerId: string): Promise<boolean> => this.consoleAdminsByKey.delete(`${serverId}|${playerId}`),
    expired: async (nowIso: string): Promise<ConsoleAdminRow[]> =>
      [...this.consoleAdminsByKey.values()].filter((a) => a.expiration !== null && a.expiration <= nowIso),
  };

  playerGroups = {
    list: async (): Promise<PlayerGroupRow[]> =>
      [...this.playerGroupsById.values()]
        .map((g) => this.withMemberCount(g))
        .sort((a, b) => a.name.localeCompare(b.name)),
    get: async (id: string): Promise<PlayerGroupRow | null> => {
      const g = this.playerGroupsById.get(id);
      return g ? this.withMemberCount(g) : null;
    },
    create: async (input: { name: string; description?: string | null; createdByUserId?: string | null; createdByName: string }): Promise<PlayerGroupRow> => {
      if ([...this.playerGroupsById.values()].some((g) => g.name === input.name)) throw new Error(`group name "${input.name}" already exists`);
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(), name: input.name, description: input.description ?? null, vipPerk: null as GroupVipPerk | null, discordRoleId: null as string | null,
        createdByUserId: input.createdByUserId ?? null, createdByName: input.createdByName,
        createdAt: now, updatedAt: now,
      };
      this.playerGroupsById.set(row.id, row);
      return this.withMemberCount(row);
    },
    setDiscordRole: async (id: string, roleId: string | null): Promise<PlayerGroupRow | null> => {
      const g = this.playerGroupsById.get(id);
      if (!g) return null;
      g.discordRoleId = roleId || null;
      g.updatedAt = new Date().toISOString();
      return this.withMemberCount(g);
    },
    setVipPerk: async (id: string, perk: GroupVipPerk | null): Promise<PlayerGroupRow | null> => {
      const g = this.playerGroupsById.get(id);
      if (!g) return null;
      g.vipPerk = perk ? { ...perk, scope: perk.scope.mode === "all" ? { mode: "all" } : { mode: perk.scope.mode, serverIds: [...perk.scope.serverIds] }, bankRewards: perk.bankRewards !== false } : null;
      g.updatedAt = new Date().toISOString();
      return this.withMemberCount(g);
    },
    update: async (id: string, patch: { name?: string; description?: string | null }): Promise<PlayerGroupRow | null> => {
      const g = this.playerGroupsById.get(id);
      if (!g) return null;
      if (patch.name !== undefined) g.name = patch.name;
      if (patch.description !== undefined) g.description = patch.description;
      g.updatedAt = new Date().toISOString();
      return this.withMemberCount(g);
    },
    remove: async (id: string): Promise<boolean> => {
      for (const key of [...this.playerGroupMembersByKey.keys()]) if (key.startsWith(`${id}|`)) this.playerGroupMembersByKey.delete(key);
      return this.playerGroupsById.delete(id);
    },
    members: async (groupId: string): Promise<PlayerGroupMemberRow[]> =>
      [...this.playerGroupMembersByKey.values()]
        .filter((m) => m.groupId === groupId)
        .map((m) => this.withCurrentName(m))
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
    addMember: async (input: { groupId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<PlayerGroupMemberRow> => {
      const key = `${input.groupId}|${input.playerId}`;
      const existing = this.playerGroupMembersByKey.get(key);
      const row: PlayerGroupMemberRow = existing
        ? { ...existing, playerName: input.playerName ?? existing.playerName }
        : { groupId: input.groupId, playerId: input.playerId, playerName: input.playerName ?? null, addedByName: input.addedByName, addedAt: new Date().toISOString(), source: "panel" };
      this.playerGroupMembersByKey.set(key, row);
      if (!existing) this.queueGroupEvent(input.groupId, row.playerId, row.playerName, "joined");
      return row;
    },
    removeMember: async (groupId: string, playerId: string): Promise<boolean> => {
      const key = `${groupId}|${playerId}`;
      const existing = this.playerGroupMembersByKey.get(key);
      if (!existing) return false;
      this.playerGroupMembersByKey.delete(key);
      this.queueGroupEvent(groupId, playerId, existing.playerName, "left");
      return true;
    },
    syncAddMember: async (input: { groupId: string; roleId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<boolean> => {
      const key = `${input.groupId}|${input.playerId}`;
      if (this.playerGroupsById.get(input.groupId)?.discordRoleId !== input.roleId || this.playerGroupMembersByKey.has(key)) return false;
      const row: PlayerGroupMemberRow = { groupId: input.groupId, playerId: input.playerId, playerName: input.playerName ?? null, addedByName: input.addedByName, addedAt: new Date().toISOString(), source: "discord" };
      this.playerGroupMembersByKey.set(key, row);
      this.queueGroupEvent(input.groupId, row.playerId, row.playerName, "joined");
      return true;
    },
    syncRemoveMember: async (input: { groupId: string; roleId: string; playerId: string }): Promise<boolean> => {
      const key = `${input.groupId}|${input.playerId}`;
      const existing = this.playerGroupMembersByKey.get(key);
      if (this.playerGroupsById.get(input.groupId)?.discordRoleId !== input.roleId || existing?.source !== "discord") return false;
      this.playerGroupMembersByKey.delete(key);
      this.queueGroupEvent(input.groupId, input.playerId, existing.playerName, "left");
      return true;
    },
    takeEvents: async (limit: number): Promise<PlayerGroupEventRow[]> => {
      // The Postgres store's rule: a dead taker's claim is dropped; then due, unclaimed ones only,
      // a member's oldest queued change first — a later one waits behind it, claimed or due or not.
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const max = Math.max(0, Math.floor(limit));
      this.playerGroupEvents = this.playerGroupEvents.filter((e) => !e.claimedAt || nowMs - Date.parse(e.claimedAt) <= GROUP_EVENT_CLAIM_MS);
      // Stable: changes made in the same millisecond keep the order they were made in.
      const queued = [...this.playerGroupEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const first = new Set<string>();
      const out: typeof queued = [];
      for (const e of queued) {
        const member = `${e.groupId}|${e.playerId}`;
        if (first.has(member)) continue;
        first.add(member);
        if (e.claimedAt || e.notBefore > now || out.length >= max) continue;
        out.push(e);
      }
      for (const e of out) e.claimedAt = now;
      return out.map((e) => {
        const { claimedAt: _c, ...row } = e;
        const superseded = queued.some((o) => o !== e && o.groupId === e.groupId && o.playerId === e.playerId);
        return { ...row, ruleIds: e.ruleIds ? [...e.ruleIds] : null, superseded };
      });
    },
    ackEvents: async (ids: string[]): Promise<void> => {
      const done = new Set(ids);
      this.playerGroupEvents = this.playerGroupEvents.filter((e) => !done.has(e.id));
    },
    deferEvent: async (event: PlayerGroupEventRow, notBefore: string, ruleIds: string[] | null): Promise<void> => {
      const when = new Date(notBefore).toISOString();
      const queued = this.playerGroupEvents.find((e) => e.id === event.id);
      if (queued) {
        // Still in its place: unclaimed, with its new time and rules.
        queued.claimedAt = null;
        queued.notBefore = when;
        queued.ruleIds = ruleIds ? [...ruleIds] : null;
        return;
      }
      // Gone (a claim that outlived GROUP_EVENT_CLAIM_MS): back ahead of anything newer and of
      // every later change of the same member, so nothing made after it overtakes it.
      const { superseded: _s, ...plain } = event;
      const row = { ...plain, notBefore: when, ruleIds: ruleIds ? [...ruleIds] : null, claimedAt: null };
      let at = this.playerGroupEvents.findIndex((e) => e.createdAt > row.createdAt || (e.groupId === row.groupId && e.playerId === row.playerId));
      if (at < 0) at = this.playerGroupEvents.length;
      this.playerGroupEvents.splice(at, 0, row);
    },
    groupsForPlayer: async (playerId: string): Promise<PlayerGroupRow[]> => {
      const groupIds = new Set([...this.playerGroupMembersByKey.values()].filter((m) => m.playerId === playerId).map((m) => m.groupId));
      return [...groupIds]
        .map((id) => this.playerGroupsById.get(id))
        .filter((g): g is NonNullable<typeof g> => !!g)
        .map((g) => this.withMemberCount(g))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  /** The memory twin of the event row the Postgres statements write alongside the change. */
  private queueGroupEvent(groupId: string, playerId: string, playerName: string | null, kind: "joined" | "left"): void {
    const group = this.playerGroupsById.get(groupId);
    if (!group) return;
    const now = new Date().toISOString();
    this.playerGroupEvents.push({ id: randomUUID(), groupId, groupName: group.name, playerId, playerName, kind, createdAt: now, notBefore: now, ruleIds: null });
  }

  private withMemberCount(g: Omit<PlayerGroupRow, "memberCount">): PlayerGroupRow {
    let n = 0;
    for (const m of this.playerGroupMembersByKey.values()) if (m.groupId === g.id) n++;
    return { ...g, memberCount: n };
  }

  seeding = {
    getConfig: async (serverId: string): Promise<SeedingConfigRow | null> => this.seedingConfigs.get(serverId) ?? null,
    listConfigs: async (): Promise<SeedingConfigRow[]> => [...this.seedingConfigs.values()],
    upsertConfig: async (serverId: string, patch: SeedingConfigPatch): Promise<SeedingConfigRow> => {
      const existing = this.seedingConfigs.get(serverId);
      const row: SeedingConfigRow = {
        ...SEEDING_DEFAULTS, ...existing, ...patch,
        serverId, updatedAt: new Date().toISOString(),
      };
      this.seedingConfigs.set(serverId, row);
      return row;
    },
    addProgress: async (serverId: string, playerId: string, playerName: string | null, deltaSeconds: number): Promise<void> => {
      const key = `${serverId}|${playerId}`;
      const prev = this.seedProgress.get(key);
      this.seedProgress.set(key, {
        serverId, playerId,
        playerName: playerName ?? prev?.playerName ?? null,
        seconds: (prev?.seconds ?? 0) + Math.max(0, deltaSeconds),
        updatedAt: new Date().toISOString(),
      });
    },
    addProgressMany: async (serverId: string, adds: { playerId: string; playerName: string | null; deltaSeconds: number }[]): Promise<void> => {
      for (const a of adds) await this.seeding.addProgress(serverId, a.playerId, a.playerName, a.deltaSeconds);
    },
    listProgress: async (serverId: string): Promise<SeedProgressRow[]> =>
      [...this.seedProgress.values()].filter((p) => p.serverId === serverId),
    clearProgress: async (serverId: string): Promise<void> => {
      for (const [k, p] of this.seedProgress) if (p.serverId === serverId) this.seedProgress.delete(k);
    },
    getState: async (serverId: string): Promise<SeedingStateRow | null> => {
      const st = this.seedingStates.get(serverId);
      const payRequested = this.seedPayRequests.has(serverId);
      if (st) return { ...st, payRequested };
      // Postgres's requestPay creates the row with its defaults; this store keeps the request
      // apart, so a request on a server with no state yet must still read as a (default) row.
      return payRequested ? { serverId, phase: "idle", liveCount: 0, seederCount: 0, lastRewardAt: null, updatedAt: new Date().toISOString(), payRequested } : null;
    },
    setState: async (state: SeedingStateRow): Promise<void> => { this.seedingStates.set(state.serverId, { ...state }); },
    setLastCycle: async (serverId: string, cycle: SeedCycleRecord): Promise<void> => { this.seedCycles.set(serverId, structuredClone(cycle)); },
    getLastCycle: async (serverId: string): Promise<SeedCycleRecord | null> => this.seedCycles.get(serverId) ?? null,
    requestPay: async (serverId: string): Promise<void> => { this.seedPayRequests.add(serverId); },
    takePayRequest: async (serverId: string): Promise<boolean> => this.seedPayRequests.delete(serverId),
  };

  mapLayouts = {
    list: async (): Promise<MapLayoutRow[]> => [...this.mapLayoutVotes.values()].map((l) => ({ ...l })).sort((a, b) => a.mapId.localeCompare(b.mapId)),
    get: async (mapId: string): Promise<MapLayoutRow | null> => { const l = this.mapLayoutVotes.get(mapId.toLowerCase()); return l ? { ...l } : null; },
    record: async (mapId: string, vote: { axis: "x" | "y"; alliesDir: -1 | 1; separation?: number; round?: string | null }): Promise<MapLayoutRow | null> => {
      const key = mapId.toLowerCase();
      const round = vote.round ?? null;
      if (round !== null && this.mapLayoutRounds.get(key) === round) return null;
      if (round !== null) this.mapLayoutRounds.set(key, round);
      const l = this.mapLayoutVotes.get(key) ?? { mapId: key, xNeg: 0, xPos: 0, yNeg: 0, yPos: 0, separation: 0, updatedAt: "" };
      const field = vote.axis === "x" ? (vote.alliesDir === -1 ? "xNeg" : "xPos") : (vote.alliesDir === -1 ? "yNeg" : "yPos");
      const next = { ...l, [field]: l[field] + 1, separation: Math.round(vote.separation ?? 0), updatedAt: new Date().toISOString() };
      this.mapLayoutVotes.set(key, next);
      return { ...next };
    },
  };

  broadcast = {
    getConfig: async (serverId: string): Promise<BroadcastConfigRow | null> => this.broadcastConfigs.get(serverId) ?? null,
    listConfigs: async (): Promise<BroadcastConfigRow[]> => [...this.broadcastConfigs.values()],
    upsertConfig: async (serverId: string, patch: BroadcastConfigPatch): Promise<BroadcastConfigRow> => {
      const existing = this.broadcastConfigs.get(serverId);
      const row: BroadcastConfigRow = {
        ...BROADCAST_DEFAULTS, ...existing, ...patch,
        serverId, updatedAt: new Date().toISOString(),
      };
      this.broadcastConfigs.set(serverId, row);
      return row;
    },
  };

  gameRewards = {
    getConfig: async (serverId: string): Promise<GameRewardsConfigRow | null> => {
      const row = this.gameRewardConfigs.get(serverId);
      return row ? { ...row, config: mergeGameRewards(JSON.parse(JSON.stringify(row.config))) } : null;
    },
    setConfig: async (serverId: string, config: GameRewardsConfig): Promise<GameRewardsConfigRow> => {
      const row = { serverId, config: mergeGameRewards(JSON.parse(JSON.stringify(config))), updatedAt: new Date().toISOString() };
      this.gameRewardConfigs.set(serverId, row);
      return { ...row, config: JSON.parse(JSON.stringify(row.config)) };
    },
    claim: async (input: { serverId: string; playerId: string; ref: string; kind: string }): Promise<boolean> => {
      const key = `${input.serverId}|${input.ref}|${input.playerId}`;
      if (this.gameRewardReceipts.has(key)) return false;
      this.gameRewardReceipts.add(key);
      return true;
    },
    release: async (input: { serverId: string; playerId: string; ref: string }): Promise<void> => {
      this.gameRewardReceipts.delete(`${input.serverId}|${input.ref}|${input.playerId}`);
    },
    addDaySeconds: async (serverId: string, kind: string, day: string, adds: { playerId: string; seconds: number }[]): Promise<{ playerId: string; seconds: number }[]> => {
      const summed = new Map<string, number>();
      for (const a of adds) if (a.playerId && a.seconds > 0) summed.set(a.playerId, (summed.get(a.playerId) ?? 0) + Math.round(a.seconds));
      return [...summed].map(([playerId, secs]) => {
        const key = `${serverId}|${playerId}|${kind}|${day}`;
        const total = (this.gameRewardDays.get(key) ?? 0) + secs;
        this.gameRewardDays.set(key, total);
        return { playerId, seconds: total };
      });
    },
    days: async (serverId: string, playerId: string, kind: string, sinceDay: string): Promise<{ day: string; seconds: number }[]> => {
      const prefix = `${serverId}|${playerId}|${kind}|`;
      return [...this.gameRewardDays].filter(([k]) => k.startsWith(prefix) && k.slice(prefix.length) >= sinceDay)
        .map(([k, seconds]) => ({ day: k.slice(prefix.length), seconds }))
        .sort((a, b) => (a.day < b.day ? -1 : 1));
    },
  };

  welcome = {
    getConfig: async (serverId: string): Promise<WelcomeConfigRow | null> => {
      const row = this.welcomeConfigs.get(serverId);
      return row ? { ...row } : null;
    },
    upsertConfig: async (serverId: string, patch: WelcomeConfigPatch): Promise<WelcomeConfigRow> => {
      const existing = this.welcomeConfigs.get(serverId);
      const row: WelcomeConfigRow = {
        lastText: null, lastWrittenAt: null,
        ...WELCOME_DEFAULTS, ...existing, ...patch,
        serverId, updatedAt: new Date().toISOString(),
      };
      // Same rule as Postgres: switched on or re-worded → the next pass writes regardless.
      if (!existing || existing.enabled !== row.enabled || existing.template !== row.template) row.lastText = null;
      this.welcomeConfigs.set(serverId, row);
      return { ...row };
    },
    markWritten: async (serverId: string, text: string | null, at: string | null): Promise<void> => {
      const row = this.welcomeConfigs.get(serverId);
      if (row) { row.lastText = text; if (at) row.lastWrittenAt = at; }
    },
  };

  discordRelay = {
    getConfig: async (serverId: string): Promise<DiscordRelayConfigRow | null> => this.discordRelayConfigs.get(serverId) ?? null,
    listConfigs: async (): Promise<DiscordRelayConfigRow[]> => [...this.discordRelayConfigs.values()],
    upsertConfig: async (serverId: string, patch: DiscordRelayConfigPatch): Promise<DiscordRelayConfigRow> => {
      const existing = this.discordRelayConfigs.get(serverId);
      const row: DiscordRelayConfigRow = {
        ...DISCORD_RELAY_DEFAULTS, ...existing, ...patch,
        serverId, updatedAt: new Date().toISOString(),
      };
      this.discordRelayConfigs.set(serverId, row);
      return row;
    },
    patchBoardState: async (serverId: string, state: { messageId: string | null; imageName: string | null }): Promise<void> => {
      // Re-read at write time, same as the Postgres jsonb merge: only these two keys change, and
      // whatever the row holds NOW — not whatever the caller read before its render — survives.
      const existing = this.discordRelayConfigs.get(serverId);
      if (!existing) return; // no config row: there is no board state to keep
      this.discordRelayConfigs.set(serverId, {
        ...existing,
        statusBoard: { ...DISCORD_STATUS_BOARD_DEFAULTS, ...existing.statusBoard, ...state },
        updatedAt: new Date().toISOString(),
      });
    },
  };

  autosettings = {
    getConfig: async (serverId: string): Promise<AutoSettingsConfigRow | null> => this.autoSettingsConfigs.get(serverId) ?? null,
    listConfigs: async (): Promise<AutoSettingsConfigRow[]> => [...this.autoSettingsConfigs.values()],
    upsertConfig: async (serverId: string, patch: AutoSettingsConfigPatch): Promise<AutoSettingsConfigRow> => {
      const existing = this.autoSettingsConfigs.get(serverId);
      const row: AutoSettingsConfigRow = {
        ...AUTOSETTINGS_DEFAULTS, ...existing, ...patch,
        serverId, updatedAt: new Date().toISOString(),
      };
      this.autoSettingsConfigs.set(serverId, row);
      return row;
    },
    templates: {
      list: async (): Promise<AutoSettingsTemplateRow[]> =>
        [...this.autoSettingsTemplates.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
      get: async (name: string): Promise<AutoSettingsTemplateRow | null> =>
        [...this.autoSettingsTemplates.values()].find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null,
      save: async (input: { name: string; config: AutoSettingsTemplateRow["config"]; createdByName: string }): Promise<AutoSettingsTemplateRow> => {
        const existing = [...this.autoSettingsTemplates.values()].find((t) => t.name.toLowerCase() === input.name.toLowerCase());
        const row: AutoSettingsTemplateRow = {
          id: existing?.id ?? randomUUID(), name: input.name, config: input.config,
          createdByName: input.createdByName, updatedAt: new Date().toISOString(),
        };
        this.autoSettingsTemplates.set(row.id, row);
        return row;
      },
      remove: async (id: string): Promise<boolean> => this.autoSettingsTemplates.delete(id),
    },
  };


  mapNames = {
    list: async (game: string): Promise<MapNameRow[]> => [...this.mapNamesByKey.values()].filter((r) => r.game === game),
    set: async (game: string, mapId: string, displayName: string) => this.setMapOverride(game, mapId, "displayName", displayName),
    setFamily: async (game: string, mapId: string, family: string) => this.setMapOverride(game, mapId, "family", family),
  };

  objectivePoints = {
    forMap: async (game: string, mapKey: string): Promise<ObjectivePointRow[]> =>
      [...this.objectivePointsByKey.values()].filter((r) => r.game === game && r.mapKey === mapKey),
    // Same patch semantics as Postgres: omitted halves keep, blank halves clear, empty rows drop.
    set: async (game: string, mapKey: string, row: number, idx: number, patch: { name?: string | null; sector?: string | null }): Promise<ObjectivePointRow | null> => {
      const key = `${game}|${mapKey}|${row}|${idx}`;
      const existing = this.objectivePointsByKey.get(key);
      const next: ObjectivePointRow = {
        game, mapKey, row, idx,
        name: patch.name !== undefined ? (String(patch.name ?? "").trim() || null) : existing?.name ?? null,
        sector: patch.sector !== undefined ? (String(patch.sector ?? "").trim() || null) : existing?.sector ?? null,
        updatedAt: new Date().toISOString(),
      };
      if (next.name === null && next.sector === null) { this.objectivePointsByKey.delete(key); return null; }
      this.objectivePointsByKey.set(key, next);
      return next;
    },
  };

  layoutExpiries = {
    list: async (): Promise<ObjectiveLayoutExpiryRow[]> => [...this.layoutExpiriesByKey.values()],
    get: async (serverId: string, mapId: string): Promise<ObjectiveLayoutExpiryRow | null> =>
      this.layoutExpiriesByKey.get(`${serverId}|${mapId}`) ?? null,
    set: async (input: { serverId: string; mapId: string; playsLeft: number; lastMatchId: string | null; setBy: string }): Promise<ObjectiveLayoutExpiryRow> => {
      const row: ObjectiveLayoutExpiryRow = { ...input, updatedAt: new Date().toISOString() };
      this.layoutExpiriesByKey.set(`${input.serverId}|${input.mapId}`, row);
      return row;
    },
    count: async (serverId: string, mapId: string, playsLeft: number, lastMatchId: string): Promise<void> => {
      const key = `${serverId}|${mapId}`;
      const cur = this.layoutExpiriesByKey.get(key);
      if (cur) this.layoutExpiriesByKey.set(key, { ...cur, playsLeft, lastMatchId, updatedAt: new Date().toISOString() });
    },
    delete: async (serverId: string, mapId: string): Promise<void> => {
      this.layoutExpiriesByKey.delete(`${serverId}|${mapId}`);
    },
  };

  // What the removed objective presets may have left (see the Repository's mapPointPending). Rows are
  // copied out, as Postgres hands back fresh objects every read.
  mapPointPending = {
    list: async (): Promise<MapPointPendingRow[]> =>
      [...this.mapPointPendingByServer.values()]
        .sort((a, b) => codeOrder(a.requestedAt, b.requestedAt) || codeOrder(a.serverId, b.serverId))
        .map((r) => structuredClone(r)),
    take: async (serverId: string, id: string): Promise<MapPointPendingRow | null> => {
      const cur = this.mapPointPendingByServer.get(serverId);
      if (!cur || cur.id !== id) return null;
      this.mapPointPendingByServer.delete(serverId);
      return cur;
    },
  };

  /** Mirrors the Postgres rule: clearing the last override drops the row, clearing one keeps it. */
  private setMapOverride(game: string, mapId: string, field: "displayName" | "family", value: string): MapNameRow | null {
    const key = `${game}|${mapId}`;
    const v = value.trim();
    const existing = this.mapNamesByKey.get(key);
    const row: MapNameRow = {
      game, mapId,
      displayName: existing?.displayName ?? null,
      family: existing?.family ?? null,
      updatedAt: new Date().toISOString(),
    };
    row[field] = v || null;
    if (row.displayName === null && row.family === null) { this.mapNamesByKey.delete(key); return null; }
    this.mapNamesByKey.set(key, row);
    return row;
  }

  private seededMapLibrary = false;
  /** Mirrors the 016_map_set_library_seed INSERT (the in-memory store never runs SQL migrations),
   *  from the very same constants, so a memory-backed run offers the same starting library. */
  private seedMapLibraryOnce(): void {
    if (this.seededMapLibrary) return;
    this.seededMapLibrary = true;
    const now = new Date().toISOString();
    for (const s of SEED_MAP_SETS) {
      const id = randomUUID();
      // The starter library is WW2 — it was written when that was the only game there was.
      this.mapSetsById.set(id, { id, name: s.name, game: "hll", pool: s.pool, createdAt: now, updatedAt: now });
    }
    for (const s of SEED_VOTE_SCHEDULES) {
      const id = randomUUID();
      this.voteSchedulesById.set(id, { id, name: s.name, spec: s.spec, createdAt: now, updatedAt: now });
    }
  }

  /** The unique-name rule the Postgres index enforces, enforced here too — a store that lets a
   *  duplicate through would make link resolution ambiguous only on this one backend. */
  private assertLibraryNameFree(taken: { id: string; name: string }[], name: string, exceptId?: string): void {
    const clash = taken.find((r) => r.name.toLowerCase() === name.trim().toLowerCase() && r.id !== exceptId);
    if (clash) throw new Error(`duplicate key value violates unique constraint: "${name.trim()}" already exists`);
  }

  /** The same narrowing the Postgres store does in SQL, so a memory-backed run answers the same
   *  question. Sorting is here too, for the same reason: the list is paged. */
  private adminCamMatches(q: AdminCamQuery): AdminCamSessionRow[] {
    let rows = this.adminCamSessions.filter((r) => {
      if (q.serverId && r.serverId !== q.serverId) return false;
      if (q.serverIds && !q.serverIds.includes(r.serverId)) return false;
      if (q.playerId && r.playerId !== q.playerId) return false;
      if (q.q && !r.playerName.toLowerCase().includes(q.q.toLowerCase())) return false;
      return true;
    });
    const sign = q.dir === "asc" ? 1 : -1;
    const nameOf = (id: string) => this.serversById.get(id)?.name ?? id;
    // Nulls last in BOTH directions, matching NULLS LAST in the query: an open session has no
    // exit and no duration and must not sort as though it were zero.
    const nulls = (a: number | string | null, b: number | string | null): number | null =>
      a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : null;
    rows = rows.slice().sort((a, b) => {
      switch (q.sort) {
        case "exited": return nulls(a.exitedAt, b.exitedAt) ?? sign * a.exitedAt!.localeCompare(b.exitedAt!);
        case "duration": return nulls(a.durationSec, b.durationSec) ?? sign * (a.durationSec! - b.durationSec!);
        case "who": return sign * a.playerName.toLowerCase().localeCompare(b.playerName.toLowerCase());
        case "server": return sign * nameOf(a.serverId).toLowerCase().localeCompare(nameOf(b.serverId).toLowerCase()) || b.enteredAt.localeCompare(a.enteredAt);
        default: return sign * a.enteredAt.localeCompare(b.enteredAt);
      }
    });
    return rows;
  }

  signatures = {
    get: async (): Promise<SignatureConfigRow> => ({ ...this.signatureConfig }),
    set: async (patch: SignatureConfigPatch): Promise<SignatureConfigRow> => {
      this.signatureConfig = {
        staffLine: patch.staffLine ?? this.signatureConfig.staffLine,
        customLine: patch.customLine ?? this.signatureConfig.customLine,
        actions: patch.actions ? parseSignatureActions(patch.actions) : this.signatureConfig.actions,
        updatedAt: new Date().toISOString(),
      };
      return { ...this.signatureConfig };
    },
  };

  adminCam = {
    open: async (input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<void> => {
      const already = this.adminCamSessions.some((r) => r.serverId === input.serverId && r.exitedAt === null
        && (input.playerId ? r.playerId === input.playerId : r.playerName === input.playerName));
      if (already) return; // a replayed log line must not open a second overlapping session
      this.adminCamSessions.push({
        id: randomUUID(), serverId: input.serverId, playerId: input.playerId, playerName: input.playerName,
        enteredAt: input.at, exitedAt: null, durationSec: null,
      });
    },
    close: async (input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<number | null> => {
      const open = this.adminCamSessions
        .filter((r) => r.serverId === input.serverId && r.exitedAt === null
          && (input.playerId ? r.playerId === input.playerId : r.playerName === input.playerName))
        .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))[0];
      if (!open) return null;
      const sec = Math.max(0, Math.round((Date.parse(input.at) - Date.parse(open.enteredAt)) / 1000));
      open.exitedAt = input.at;
      open.durationSec = sec;
      return sec;
    },
    importOne: async (input: { serverId: string; playerId: string | null; playerName: string; enteredAt: string; exitedAt: string; durationSec: number }): Promise<boolean> => {
      const dup = this.adminCamSessions.some((r) => r.serverId === input.serverId && r.enteredAt === input.enteredAt
        && (input.playerId ? r.playerId === input.playerId : r.playerName === input.playerName));
      if (dup) return false;
      this.adminCamSessions.push({
        id: randomUUID(), serverId: input.serverId, playerId: input.playerId, playerName: input.playerName,
        enteredAt: input.enteredAt, exitedAt: input.exitedAt, durationSec: input.durationSec,
      });
      return true;
    },
    list: async (query: AdminCamQuery = {}): Promise<AdminCamSessionRow[]> => {
      const rows = this.adminCamMatches(query);
      const offset = Math.max(query.offset ?? 0, 0);
      return rows.slice(offset, offset + Math.min(Math.max(query.limit ?? 50, 1), 500)).map((r) => ({ ...r }));
    },
    count: async (query: AdminCamQuery = {}): Promise<number> => this.adminCamMatches(query).length,
    admins: async (serverIds?: string[]): Promise<{ playerId: string | null; playerName: string }[]> => {
      const by = new Map<string, { playerId: string | null; playerName: string }>();
      for (const r of this.adminCamSessions) {
        if (serverIds && !serverIds.includes(r.serverId)) continue;
        const key = r.playerName.toLowerCase();
        if (!by.has(key)) by.set(key, { playerId: r.playerId, playerName: r.playerName });
      }
      return [...by.values()].sort((a, b) => a.playerName.toLowerCase().localeCompare(b.playerName.toLowerCase()));
    },
    getConfig: async (serverId: string): Promise<AdminCamConfigRow | null> => this.adminCamConfigs.get(serverId) ?? null,
    setConfig: async (serverId: string, patch: AdminCamConfigPatch): Promise<AdminCamConfigRow> => {
      const e = this.adminCamConfigs.get(serverId);
      const row: AdminCamConfigRow = {
        serverId,
        notifyEnabled: patch.notifyEnabled ?? e?.notifyEnabled ?? ADMIN_CAM_DEFAULTS.notifyEnabled,
        enterMessage: patch.enterMessage ?? e?.enterMessage ?? ADMIN_CAM_DEFAULTS.enterMessage,
        exitMessage: patch.exitMessage ?? e?.exitMessage ?? ADMIN_CAM_DEFAULTS.exitMessage,
        updatedAt: new Date().toISOString(),
      };
      this.adminCamConfigs.set(serverId, row);
      return { ...row };
    },
  };

  mapSets = {
    list: async (game?: string): Promise<MapSetRow[]> => {
      this.seedMapLibraryOnce();
      return [...this.mapSetsById.values()]
        .filter((r) => !game || r.game === game)
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    },
    get: async (id: string): Promise<MapSetRow | null> => { this.seedMapLibraryOnce(); return this.mapSetsById.get(id) ?? null; },
    findByName: async (name: string): Promise<MapSetRow | null> => {
      this.seedMapLibraryOnce();
      return [...this.mapSetsById.values()].find((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
    },
    create: async (input: { id?: string; name: string; game: string; pool?: Record<string, unknown> }): Promise<MapSetRow> => {
      this.seedMapLibraryOnce();
      this.assertLibraryNameFree([...this.mapSetsById.values()], input.name);
      if (input.id && this.mapSetsById.has(input.id)) throw new Error("duplicate key: a map set with that id exists");
      const now = new Date().toISOString();
      const row: MapSetRow = { id: input.id ?? randomUUID(), name: input.name.trim(), game: input.game, pool: input.pool ?? {}, createdAt: now, updatedAt: now };
      this.mapSetsById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: { name?: string; game?: string; pool?: Record<string, unknown> }): Promise<MapSetRow | null> => {
      const row = this.mapSetsById.get(id);
      if (!row) return null;
      if (patch.name !== undefined) { this.assertLibraryNameFree([...this.mapSetsById.values()], patch.name, id); row.name = patch.name.trim(); }
      if (patch.game !== undefined) row.game = patch.game;
      if (patch.pool !== undefined) row.pool = patch.pool;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.mapSetsById.delete(id),
  };

  mapZones = {
    list: async (game?: string): Promise<MapZoneSetRow[]> =>
      [...this.mapZoneSetsById.values()]
        .filter((r) => !game || r.game === game)
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    get: async (id: string): Promise<MapZoneSetRow | null> => this.mapZoneSetsById.get(id) ?? null,
    create: async (input: { name: string; game: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow> => {
      this.assertLibraryNameFree([...this.mapZoneSetsById.values()], input.name);
      const now = new Date().toISOString();
      const row: MapZoneSetRow = { id: randomUUID(), name: input.name.trim(), game: input.game, zones: input.zones ?? {}, createdAt: now, updatedAt: now };
      this.mapZoneSetsById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: { name?: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow | null> => {
      const row = this.mapZoneSetsById.get(id);
      if (!row) return null;
      if (patch.name !== undefined) { this.assertLibraryNameFree([...this.mapZoneSetsById.values()], patch.name, id); row.name = patch.name.trim(); }
      if (patch.zones !== undefined) row.zones = patch.zones;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.mapZoneSetsById.delete(id),
  };

  voteSchedules = {
    list: async (): Promise<VoteScheduleRow[]> => {
      this.seedMapLibraryOnce();
      return [...this.voteSchedulesById.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    },
    get: async (id: string): Promise<VoteScheduleRow | null> => { this.seedMapLibraryOnce(); return this.voteSchedulesById.get(id) ?? null; },
    findByName: async (name: string): Promise<VoteScheduleRow | null> => {
      this.seedMapLibraryOnce();
      return [...this.voteSchedulesById.values()].find((r) => r.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
    },
    create: async (input: { id?: string; name: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow> => {
      this.seedMapLibraryOnce();
      this.assertLibraryNameFree([...this.voteSchedulesById.values()], input.name);
      if (input.id && this.voteSchedulesById.has(input.id)) throw new Error("duplicate key: a schedule with that id exists");
      const now = new Date().toISOString();
      const row: VoteScheduleRow = { id: input.id ?? randomUUID(), name: input.name.trim(), spec: input.spec ?? {}, createdAt: now, updatedAt: now };
      this.voteSchedulesById.set(row.id, row);
      return row;
    },
    update: async (id: string, patch: { name?: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow | null> => {
      const row = this.voteSchedulesById.get(id);
      if (!row) return null;
      if (patch.name !== undefined) { this.assertLibraryNameFree([...this.voteSchedulesById.values()], patch.name, id); row.name = patch.name.trim(); }
      if (patch.spec !== undefined) row.spec = patch.spec;
      row.updatedAt = new Date().toISOString();
      return row;
    },
    remove: async (id: string): Promise<boolean> => this.voteSchedulesById.delete(id),
  };

  /** Resolve a stored config against the library AT READ TIME. Editing a shared set has to change
   *  every server that uses it, so the resolution cannot be cached into the stored row. */
  private hydrateConfig(row: MapVoteConfigRow): MapVoteConfigRow {
    this.seedMapLibraryOnce();
    const library = { sets: [...this.mapSetsById.values()], schedules: [...this.voteSchedulesById.values()] };
    return { ...row, profiles: hydrateLinks(row.profileLinks, library) };
  }

  mapVote = {
    getConfig: async (serverId: string): Promise<MapVoteConfigRow | null> => {
      const row = this.mapVoteConfigs.get(serverId);
      return row ? this.hydrateConfig(row) : null;
    },
    listConfigs: async (): Promise<MapVoteConfigRow[]> => [...this.mapVoteConfigs.values()].map((r) => this.hydrateConfig(r)),
    setConfig: async (serverId: string, patch: MapVoteConfigPatch): Promise<MapVoteConfigRow> => {
      const existing = this.mapVoteConfigs.get(serverId);
      const row: MapVoteConfigRow = {
        serverId,
        enabled: patch.enabled ?? existing?.enabled ?? false,
        surface: patch.surface ?? existing?.surface ?? "native",
        channelId: patch.channelId !== undefined ? patch.channelId : existing?.channelId ?? null,
        pollHours: patch.pollHours ?? existing?.pollHours ?? 24,
        timezone: patch.timezone ?? existing?.timezone ?? "UTC",
        // Stored: the pairings. `profiles` is filled in by hydrateConfig on the way back out.
        profileLinks: patch.profiles ?? existing?.profileLinks ?? [],
        profiles: [],
        reminders: patch.reminders ?? existing?.reminders ?? [],
        liveApply: patch.liveApply ?? existing?.liveApply ?? true,
        postMatchApplyDelaySeconds: patch.postMatchApplyDelaySeconds ?? existing?.postMatchApplyDelaySeconds ?? 300,
        pollResetDelaySeconds: patch.pollResetDelaySeconds ?? existing?.pollResetDelaySeconds ?? 180,
        tidyChannel: patch.tidyChannel ?? existing?.tidyChannel ?? true,
        pauseBelowPlayers: patch.pauseBelowPlayers ?? existing?.pauseBelowPlayers ?? 0,
        registeredOnlyIngame: patch.registeredOnlyIngame ?? existing?.registeredOnlyIngame ?? false,
        registeredOnlyDiscord: patch.registeredOnlyDiscord ?? existing?.registeredOnlyDiscord ?? false,
        startupState: patch.startupState ?? existing?.startupState ?? "remember",
        updatedAt: new Date().toISOString(),
      };
      this.mapVoteConfigs.set(serverId, row);
      return this.hydrateConfig(row);
    },
    getState: async (serverId: string): Promise<MapVoteStateRow | null> => this.mapVoteStates.get(serverId) ?? null,
    setState: async (state: MapVoteStateRow): Promise<void> => { this.mapVoteStates.set(state.serverId, { ...state }); },
    patchState: async (serverId: string, patch: MapVoteStatePatch): Promise<MapVoteStateRow> => {
      // Merge onto whatever is stored NOW, not onto a snapshot the caller is holding — that is the
      // whole point of the method. See the interface note in types.ts.
      const current = this.mapVoteStates.get(serverId) ?? blankMapVoteState(serverId);
      const next: MapVoteStateRow = { ...current, ...patch, serverId, updatedAt: new Date().toISOString() };
      this.mapVoteStates.set(serverId, next);
      return { ...next };
    },
    recordHistory: async (input: NewMapVoteHistory): Promise<MapVoteHistoryRow> => {
      const row: MapVoteHistoryRow = {
        id: randomUUID(), serverId: input.serverId, decidedAt: input.decidedAt ?? new Date().toISOString(),
        profile: input.profile ?? null, options: input.options ?? [],
        winnerId: input.winnerId ?? null, winnerName: input.winnerName ?? null,
        totalVotes: input.totalVotes ?? 0, outcome: input.outcome, applied: input.applied ?? false,
      };
      this.mapVoteHistory.push(row);
      // Flatten the ballot the same way Postgres does, so analytics behave identically on both stores.
      for (const o of row.options) {
        for (const v of o.voters ?? []) {
          if (!v?.discordId) continue;
          const dup = this.mapVoteBallots.some((b) => b.historyId === row.id && b.mapId === o.id && b.discordUserId === v.discordId);
          if (dup) continue;
          this.mapVoteBallots.push({
            id: randomUUID(), historyId: row.id, serverId: row.serverId, decidedAt: row.decidedAt,
            mapId: o.id, mapName: o.name || o.id, discordUserId: v.discordId,
            discordName: v.name || v.discordId, won: o.id === row.winnerId,
          });
        }
      }
      return row;
    },
    history: async (serverId: string, limit = 50, offset = 0): Promise<MapVoteHistoryRow[]> =>
      this.mapVoteHistory.filter((h) => h.serverId === serverId)
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
        .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(500, limit))),
    historyCount: async (serverId: string): Promise<number> =>
      this.mapVoteHistory.filter((h) => h.serverId === serverId).length,
    historySummary: async (serverId: string) => {
      const all = this.mapVoteHistory.filter((h) => h.serverId === serverId);
      return {
        rounds: all.length,
        decided: all.filter((h) => h.outcome === "vote").length,
        forced: all.filter((h) => h.outcome === "override").length,
        silent: all.filter((h) => h.outcome === "no_votes").length,
        totalVotes: all.reduce((n, h) => n + (h.totalVotes ?? 0), 0),
        contested: all.filter((h) => (h.totalVotes ?? 0) > 0).length,
      };
    },
    mapTally: async (serverId: string, limit = 200): Promise<MapVoteTally[]> => {
      const acc = new Map<string, MapVoteTally>();
      for (const h of this.mapVoteHistory.filter((x) => x.serverId === serverId)) {
        for (const o of h.options) {
          const e = acc.get(o.id) ?? { mapId: o.id, name: o.name || o.id, offered: 0, won: 0, votes: 0 };
          e.offered += 1;
          e.votes += o.votes ?? 0;
          if (h.winnerId === o.id) e.won += 1;
          acc.set(o.id, e);
        }
      }
      return [...acc.values()].sort((a, b) => b.won - a.won || b.offered - a.offered).slice(0, Math.max(1, Math.min(1000, limit)));
    },
    voterSummary: async (serverId: string, limit = 100): Promise<MapVoteVoterSummary[]> => {
      const acc = new Map<string, MapVoteVoterSummary>();
      // Newest first so the name we keep is the one they go by now.
      const rows = this.mapVoteBallots.filter((b) => b.serverId === serverId).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
      for (const b of rows) {
        const ingame = b.discordUserId.startsWith("player:");
        const e = acc.get(b.discordUserId) ?? {
          discordUserId: b.discordUserId,
          // Never the raw identity as a fallback name: for an in-game voter that is
          // "player:<uuid>", an internal id printed where staff expect a person.
          discordName: b.discordName || (ingame ? "(unnamed player)" : b.discordUserId),
          votes: 0, wins: 0,
          lastVotedAt: b.decidedAt, userId: null, playerId: null, playerName: null, ingame,
        };
        e.votes += 1;
        if (b.won) e.wins += 1;
        if (b.decidedAt > e.lastVotedAt) e.lastVotedAt = b.decidedAt;
        acc.set(b.discordUserId, e);
      }
      // Turn each identity into a person. A snowflake goes through the external link; an IN-GAME
      // voter carries their player id inside the identity itself ("player:<key>"), so it resolves
      // directly — without that, the panel told staff a player it knows by name was "not linked to
      // a game account" and pointed them at a Discord link that was never the problem.
      for (const e of acc.values()) {
        if (e.ingame) {
          const player = this.playersById.get(e.discordUserId.slice("player:".length)) ?? null;
          e.playerId = player?.id ?? null;
          e.playerName = player?.name ?? null;
          continue;
        }
        e.userId = (await this.users.findByDiscordId(e.discordUserId))?.id ?? null;
        const player = await this.externalLinks.findPlayer("discord", e.discordUserId);
        e.playerId = player?.id ?? null;
        e.playerName = player?.name ?? null;
      }
      return [...acc.values()]
        .sort((a, b) => b.votes - a.votes || b.lastVotedAt.localeCompare(a.lastVotedAt))
        .slice(0, Math.max(1, Math.min(500, limit)));
    },
    preferences: async (discordUserId: string, opts: { serverId?: string; serverIds?: string[]; limit?: number } = {}): Promise<MapVotePreference[]> => {
      const acc = new Map<string, MapVotePreference>();
      for (const b of this.mapVoteBallots) {
        if (b.discordUserId !== discordUserId) continue;
        if (opts.serverId && b.serverId !== opts.serverId) continue;
        if (opts.serverIds && !opts.serverIds.includes(b.serverId)) continue;
        const e = acc.get(b.mapId) ?? { mapId: b.mapId, name: b.mapName, votes: 0, wins: 0, lastVotedAt: b.decidedAt };
        e.votes += 1;
        if (b.won) e.wins += 1;
        if (b.decidedAt >= e.lastVotedAt) { e.lastVotedAt = b.decidedAt; e.name = b.mapName; }
        acc.set(b.mapId, e);
      }
      return [...acc.values()]
        .sort((a, b) => b.votes - a.votes || b.lastVotedAt.localeCompare(a.lastVotedAt))
        .slice(0, Math.max(1, Math.min(500, opts.limit ?? 50)));
    },
    ballots: async (discordUserId: string, opts: { serverId?: string; serverIds?: string[]; limit?: number } = {}): Promise<MapVoteBallotRow[]> =>
      this.mapVoteBallots
        .filter((b) => b.discordUserId === discordUserId && (!opts.serverId || b.serverId === opts.serverId)
          && (!opts.serverIds || opts.serverIds.includes(b.serverId)))
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
        .slice(0, Math.max(1, Math.min(500, opts.limit ?? 100)))
        .map((b) => ({ ...b })),
    voterTotals: async (discordUserId: string, serverId?: string, serverIds?: string[]) => {
      const rows = this.mapVoteBallots.filter((b) => b.discordUserId === discordUserId && (!serverId || b.serverId === serverId)
        && (!serverIds || serverIds.includes(b.serverId)));
      const dates = rows.map((b) => b.decidedAt).sort();
      return {
        votes: rows.length,
        wins: rows.filter((b) => b.won).length,
        firstVotedAt: dates[0] ?? null,
        lastVotedAt: dates[dates.length - 1] ?? null,
      };
    },
  };

  /**
   * Bans as staff meant them. Never deleted — a lift stamps the row, so the history stays readable.
   */
  playerBans = {
    list: async (query: { game?: string; playerId?: string; activeOnly?: boolean } = {}): Promise<PlayerBanRow[]> => {
      const now = new Date().toISOString();
      return [...this.playerBansById.values()]
        .filter((b) => (query.game ? b.game === query.game : true))
        .filter((b) => (query.playerId ? b.playerId === query.playerId : true))
        .filter((b) => (query.activeOnly ? b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now) : true))
        // Ties are real: an approval applying several bans at once stamps them the same instant.
        // Break by id, like Postgres does, so a batch cannot shuffle between two reads.
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    get: async (id: string): Promise<PlayerBanRow | null> => this.playerBansById.get(id) ?? null,
    create: async (input: NewPlayerBan): Promise<PlayerBanRow> => {
      const row: PlayerBanRow = {
        id: randomUUID(), game: input.game, playerId: input.playerId, playerName: input.playerName ?? null,
        kind: input.kind, reason: input.reason, category: input.category ?? null, scope: input.scope,
        expiresAt: input.expiresAt ?? null, createdByUserId: input.createdByUserId ?? null,
        createdByName: input.createdByName, createdAt: input.createdAt ?? new Date().toISOString(),
        liftedAt: null, liftedByName: null,
      };
      this.playerBansById.set(row.id, row);
      return row;
    },
    lift: async (id: string, liftedByName: string, liftedAt?: string): Promise<boolean> => {
      const row = this.playerBansById.get(id);
      // Already lifted is not an error and not a second event: the first lift is the fact.
      if (!row || row.liftedAt !== null) return false;
      row.liftedAt = liftedAt ?? new Date().toISOString();
      row.liftedByName = liftedByName;
      return true;
    },
    liftAllFor: async (playerId: string, liftedByName: string, kind?: "temp" | "perma"): Promise<number> => {
      const now = new Date().toISOString();
      let n = 0;
      for (const row of this.playerBansById.values()) {
        if (row.playerId !== playerId || row.liftedAt !== null) continue;
        if (kind && row.kind !== kind) continue;
        row.liftedAt = now; row.liftedByName = liftedByName; n++;
      }
      return n;
    },
    setScope: async (id: string, scope: BanScopeJson): Promise<boolean> => {
      const row = this.playerBansById.get(id);
      if (!row || row.liftedAt !== null) return false;
      row.scope = scope;
      return true;
    },
    setExpiry: async (id: string, expiresAt: string | null): Promise<boolean> => {
      const row = this.playerBansById.get(id);
      if (!row || row.liftedAt) return false;
      row.expiresAt = expiresAt;
      return true;
    },
  };

  economy = {
    member: async (discordId: string): Promise<CommunityMemberRow | null> => {
      const m = this.economyMembers.get(discordId);
      return m ? { ...m } : null;
    },
    ensureMember: async (discordId: string, discordName?: string | null): Promise<CommunityMemberRow> => {
      const now = new Date().toISOString();
      let m = this.economyMembers.get(discordId);
      if (!m) {
        m = { discordId, discordName: discordName ?? null, balance: 0, createdAt: now, updatedAt: now };
        this.economyMembers.set(discordId, m);
      } else if (discordName && discordName !== m.discordName) {
        m.discordName = discordName; m.updatedAt = now;
      }
      return { ...m };
    },
    members: async (query: { q?: string; limit?: number; offset?: number } = {}): Promise<CommunityMemberRow[]> => {
      const q = (query.q ?? "").toLowerCase();
      const all = [...this.economyMembers.values()]
        .filter((m) => !q || m.discordId.includes(q) || (m.discordName ?? "").toLowerCase().includes(q))
        .sort((a, b) => b.balance - a.balance || a.discordId.localeCompare(b.discordId));
      const off = query.offset ?? 0;
      return all.slice(off, off + (query.limit ?? all.length)).map((m) => ({ ...m }));
    },
    membersCount: async (q?: string): Promise<number> => (await this.economy.members({ q })).length,
    overCap: async (cap: number | null): Promise<{ members: number; excess: number }> => {
      if (cap === null) return { members: 0, excess: 0 };
      const over = [...this.economyMembers.values()].filter((m) => m.balance > cap);
      return { members: over.length, excess: over.reduce((n, m) => n + (m.balance - cap), 0) };
    },
    trimToCap: async (cap: number, actorName: string, reason = "balance cap trim"): Promise<{ members: number; removed: number }> => {
      // Mirrors the Postgres store exactly — see the interface doc for the contract.
      const now = new Date().toISOString();
      let members = 0, removed = 0;
      for (const m of [...this.economyMembers.values()].sort((a, b) => a.discordId.localeCompare(b.discordId))) {
        if (m.balance <= cap) continue;
        const delta = cap - m.balance;
        this.economyEntries.push({
          id: randomUUID(), discordId: m.discordId, delta, reason,
          ref: null, actorName, createdAt: now,
        });
        m.balance = cap; m.updatedAt = now;
        members += 1; removed += -delta;
      }
      return { members, removed };
    },
    apply: async (entry: NewEconomyEntry, opts: { maxBalance?: number | null } = {}): Promise<{ member: CommunityMemberRow; entry: EconomyLedgerRow; applied: boolean }> => {
      await this.economy.ensureMember(entry.discordId, entry.discordName ?? undefined);
      const m = this.economyMembers.get(entry.discordId)!;
      if (entry.ref) {
        // The ref already owns its event: this call is a replay, and replays change nothing.
        const existing = this.economyRefs.get(entry.ref);
        if (existing) return { member: { ...m }, entry: { ...existing }, applied: false };
      }
      let delta = Math.trunc(entry.delta);
      const cap = opts.maxBalance ?? null;
      // Credits TRIM at the cap (the applied delta is what the row records, possibly zero);
      // debits below zero refuse — an overdraft is a caller bug, not a clamp.
      if (delta > 0 && cap !== null) delta = Math.min(delta, Math.max(0, cap - m.balance));
      if (m.balance + delta < 0) throw new InsufficientBalance(m.balance, -delta);
      const now = new Date().toISOString();
      const row: EconomyLedgerRow = {
        id: randomUUID(), discordId: entry.discordId, delta, reason: entry.reason,
        ref: entry.ref ?? null, actorName: entry.actorName ?? null, createdAt: now,
      };
      this.economyEntries.push(row);
      if (row.ref) this.economyRefs.set(row.ref, row);
      m.balance += delta; m.updatedAt = now;
      return { member: { ...m }, entry: { ...row }, applied: true };
    },
    activity: async (opts: { kind?: string; limit?: number; offset?: number } = {}): Promise<{ entries: EconomyActivityRow[]; total: number }> => {
      // Unknown kind = nothing, deliberately: a caller with a typo must not be handed the whole
      // ledger and read it as that kind.
      if (opts.kind !== undefined && !(opts.kind in ECONOMY_ACTIVITY_KINDS)) return { entries: [], total: 0 };
      const all = this.economyEntries
        .filter((e) => opts.kind === undefined || economyActivityKind(e.ref) === opts.kind)
        .slice()
        .reverse();
      const off = opts.offset ?? 0;
      const entries = all.slice(off, off + (opts.limit ?? ECONOMY_LEDGER_PAGE)).map((e) => ({
        ...e,
        discordName: this.economyMembers.get(e.discordId)?.discordName ?? null,
        kind: economyActivityKind(e.ref),
      }));
      return { entries, total: all.length };
    },
    ledger: async (discordId: string, opts: { limit?: number; offset?: number } = {}): Promise<EconomyLedgerRow[]> => {
      const all = this.economyEntries.filter((e) => e.discordId === discordId).reverse();
      const off = opts.offset ?? 0;
      // The same page Postgres serves. This used to return every row when no limit was given,
      // which meant a caller who forgot one read the whole ledger here and a 100-row page there.
      return all.slice(off, off + (opts.limit ?? ECONOMY_LEDGER_PAGE)).map((e) => ({ ...e }));
    },
    ledgerCount: async (discordId: string): Promise<number> =>
      this.economyEntries.filter((e) => e.discordId === discordId).length,
    lastEntryWithRefPrefix: async (discordId: string, prefix: string): Promise<EconomyLedgerRow | null> => {
      for (let i = this.economyEntries.length - 1; i >= 0; i--) {
        const e = this.economyEntries[i]!;
        if (e.discordId === discordId && e.ref?.startsWith(prefix)) return { ...e };
      }
      return null;
    },
    config: async (): Promise<EconomyConfig> => {
      const stored = JSON.parse(JSON.stringify(this.economyConfig)) as EconomyConfig;
      // Per-band, like the Postgres store: a patch that wrote a whole band before a field existed
      // (or a caller that sent a partial band) must still read back complete.
      return {
        ...stored,
        claims: {
          daily: { ...ECONOMY_DEFAULTS.claims.daily, ...(stored.claims?.daily ?? {}) },
          monthly: { ...ECONOMY_DEFAULTS.claims.monthly, ...(stored.claims?.monthly ?? {}) },
        },
        gifting: { ...ECONOMY_DEFAULTS.gifting, ...(stored.gifting ?? {}) },
        vipGifting: { ...ECONOMY_DEFAULTS.vipGifting, ...(stored.vipGifting ?? {}) },
        registration: { ...ECONOMY_DEFAULTS.registration, ...(stored.registration ?? {}) },
        // An offer saved before role gating existed carries no roleIds; it reads back ungated.
        offers: (stored.offers ?? []).map((o) => ({ ...o, roleIds: o.roleIds ?? [] })),
      };
    },
    setConfig: async (patch: EconomyConfigPatch): Promise<EconomyConfig> => {
      // Stored as sent (partial bands included); config() above completes every read from the
      // defaults, so the resting shape may be narrower than EconomyConfig claims.
      this.economyConfig = { ...this.economyConfig, ...JSON.parse(JSON.stringify(patch)) as EconomyConfig, updatedAt: new Date().toISOString() };
      return this.economy.config();
    },
  };

  private appConfigRow: AppConfig = { ...APP_CONFIG_DEFAULTS, updatedAt: new Date(0).toISOString() };
  private chatFilterRow: ChatFilterConfig = { ...CHAT_FILTER_DEFAULTS, updatedAt: new Date(0).toISOString() };

  chatFilter = {
    get: async (): Promise<ChatFilterConfig> => ({ ...this.chatFilterRow, words: [...this.chatFilterRow.words], censorApplied: { ...this.chatFilterRow.censorApplied } }),
    set: async (patch: Partial<Omit<ChatFilterConfig, "updatedAt">>): Promise<ChatFilterConfig> => {
      this.chatFilterRow = { ...this.chatFilterRow, ...patch, updatedAt: new Date().toISOString() };
      return this.chatFilter.get();
    },
  };

  appConfig = {
    get: async (): Promise<AppConfig> => ({ ...this.appConfigRow }),
    set: async (patch: Partial<Omit<AppConfig, "updatedAt">>): Promise<AppConfig> => {
      this.appConfigRow = {
        ...this.appConfigRow,
        ...patch,
        // Normalised on the way IN: a zone the runtime cannot use would otherwise be discovered
        // by a worker at 3am, mid-claim.
        ...(patch.timezone !== undefined ? { timezone: safeTimezone(patch.timezone, this.appConfigRow.timezone) } : {}),
        updatedAt: new Date().toISOString(),
      };
      return this.appConfig.get();
    },
  };

  private installValues = new Map<string, string>();
  installSettings = {
    get: async (key: string): Promise<string | null> => this.installValues.get(key) ?? null,
    set: async (key: string, value: string | null): Promise<void> => {
      if (value === null) this.installValues.delete(key);
      else this.installValues.set(key, value);
    },
    getOrCreate: async (key: string, make: () => string): Promise<string> => {
      const kept = this.installValues.get(key);
      if (kept !== undefined) return kept;
      const fresh = make();
      this.installValues.set(key, fresh);
      return fresh;
    },
  };

  private brandImageRows = new Map<BrandImageKey, BrandImageRow>();
  brandImages = {
    get: async (key: BrandImageKey): Promise<BrandImageRow | null> => {
      const row = this.brandImageRows.get(key);
      return row ? { ...row, bytes: new Uint8Array(row.bytes) } : null;
    },
    set: async (key: BrandImageKey, image: { mime: string; bytes: Uint8Array; by: string | null }): Promise<BrandImageRow> => {
      this.brandImageRows.set(key, { key, mime: image.mime, bytes: new Uint8Array(image.bytes), updatedAt: new Date().toISOString(), updatedBy: image.by });
      return (await this.brandImages.get(key))!;
    },
    remove: async (key: BrandImageKey): Promise<boolean> => this.brandImageRows.delete(key),
  };

  discordCommands = {
    get: async (): Promise<DiscordCommandConfig> => JSON.parse(JSON.stringify(this.discordCommandConfig)) as DiscordCommandConfig,
    set: async (patch: Partial<Omit<DiscordCommandConfig, "updatedAt">>): Promise<DiscordCommandConfig> => {
      this.discordCommandConfig = {
        ...this.discordCommandConfig,
        ...JSON.parse(JSON.stringify(patch)) as typeof patch,
        updatedAt: new Date().toISOString(),
      };
      return this.discordCommands.get();
    },
  };

  private payoutJobs: PayoutJobRow[] = [];
  private payoutItems: PayoutItemRow[] = [];
  private payoutItemSeq = 0;

  payouts = {
    create: async (input: NewPayoutJob): Promise<PayoutJobRow> => {
      // Field by field, never {...input}: the spread is how two public-API fields passed a green
      // suite while the SQL store persisted nothing (docs/streamer-mode.md). Money doubly so.
      const row: PayoutJobRow = {
        id: randomUUID(),
        sourceType: input.sourceType,
        sourceRef: input.sourceRef ?? {},
        payoutType: input.payoutType,
        amount: input.amount,
        serverIds: [...(input.serverIds ?? [])],
        audience: input.audience,
        dryRun: input.dryRun,
        status: input.status,
        requestedByUserId: input.requestedByUserId ?? null,
        requestedByName: input.requestedByName ?? "",
        createdAt: new Date().toISOString(),
        completedAt: null,
        totalCount: input.totalCount,
        successCount: 0,
        failedCount: 0,
        duplicateKey: input.duplicateKey,
      };
      this.payoutJobs.push(row);
      return { ...row };
    },
    addItem: async (input: NewPayoutItem): Promise<void> => {
      this.payoutItems.push({
        id: ++this.payoutItemSeq,
        jobId: input.jobId,
        playerId: input.playerId ?? null,
        discordId: input.discordId ?? null,
        displayName: input.displayName ?? "",
        status: input.status,
        error: input.error ?? "",
        detail: input.detail ?? {},
        createdAt: new Date().toISOString(),
      });
    },
    openItems: async (jobId: string, rows: { playerId: string | null; discordId: string | null; displayName: string }[]): Promise<number[]> =>
      rows.map((r) => {
        const id = ++this.payoutItemSeq;
        this.payoutItems.push({
          id, jobId, playerId: r.playerId ?? null, discordId: r.discordId ?? null, displayName: r.displayName ?? "",
          status: "PENDING", error: "", detail: {}, createdAt: new Date().toISOString(),
        });
        return id;
      }),
    settleItem: async (id: number, outcome: { status: "PASS" | "FAIL"; error: string; detail: Record<string, unknown> }): Promise<void> => {
      const row = this.payoutItems.find((i) => i.id === id);
      if (!row) return;
      row.status = outcome.status;
      row.error = outcome.error ?? "";
      row.detail = outcome.detail ?? {};
    },
    finish: async (id: string, patch: { status: PayoutJobRow["status"]; successCount: number; failedCount: number }): Promise<void> => {
      const row = this.payoutJobs.find((j) => j.id === id);
      if (!row) return;
      row.status = patch.status;
      row.successCount = patch.successCount;
      row.failedCount = patch.failedCount;
      row.completedAt = new Date().toISOString();
    },
    get: async (id: string): Promise<PayoutJobRow | null> => {
      const row = this.payoutJobs.find((j) => j.id === id);
      return row ? { ...row, serverIds: [...row.serverIds] } : null;
    },
    list: async (opts?: { limit?: number; offset?: number }): Promise<PayoutJobRow[]> =>
      this.payoutJobs.slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50))
        .map((r) => ({ ...r, serverIds: [...r.serverIds] })),
    count: async (): Promise<number> => this.payoutJobs.length,
    forEvents: async (eventIds: string[]): Promise<PayoutJobRow[]> => {
      const wanted = new Set(eventIds);
      const chain = new Set(this.payoutJobs
        .filter((j) => j.sourceType === "event" && !j.dryRun && typeof j.sourceRef.eventId === "string" && wanted.has(j.sourceRef.eventId))
        .map((j) => j.id));
      // Link by link, as the SQL store's recursive query walks it, until a pass adds nobody.
      for (let grew = chain.size > 0; grew;) {
        grew = false;
        for (const j of this.payoutJobs) {
          if (chain.has(j.id) || j.sourceType !== "retry" || j.dryRun) continue;
          if (typeof j.sourceRef.jobId === "string" && chain.has(j.sourceRef.jobId)) { chain.add(j.id); grew = true; }
        }
      }
      return this.payoutJobs.filter((j) => chain.has(j.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((r) => ({ ...r, serverIds: [...r.serverIds] }));
    },
    items: async (jobId: string, opts?: { limit?: number; offset?: number }): Promise<PayoutItemRow[]> =>
      this.payoutItems.filter((i) => i.jobId === jobId)
        .sort((a, b) => a.id - b.id)
        .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 500))
        .map((r) => ({ ...r })),
    itemsCount: async (jobId: string): Promise<number> => this.payoutItems.filter((i) => i.jobId === jobId).length,
    failedItems: async (jobId: string, opts?: { includePending?: boolean }): Promise<PayoutItemRow[]> =>
      this.payoutItems.filter((i) => i.jobId === jobId && (i.status === "FAIL" || (opts?.includePending === true && i.status === "PENDING")))
        .sort((a, b) => a.id - b.id).map((r) => ({ ...r })),
    findDuplicate: async (duplicateKey: string): Promise<PayoutJobRow | null> => {
      const row = this.payoutJobs
        .filter((j) => j.duplicateKey === duplicateKey && !j.dryRun
          && (j.status === "RUNNING" || j.status === "COMPLETE" || j.status === "COMPLETE_WITH_FAILURES" || j.status === "INTERRUPTED"))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return row ? { ...row } : null;
    },
    interruptStale: async (): Promise<number> => {
      let n = 0;
      for (const j of this.payoutJobs) {
        if (j.status !== "RUNNING") continue;
        const mine = this.payoutItems.filter((i) => i.jobId === j.id);
        j.status = "INTERRUPTED";
        j.completedAt = new Date().toISOString();
        j.successCount = mine.filter((i) => i.status === "PASS").length;
        j.failedCount = mine.filter((i) => i.status !== "PASS").length;
        n++;
      }
      return n;
    },
  };

  private payoutEventRows: PayoutEventRow[] = [];
  private eventPostConfig: EventPostConfig | null = null;

  payoutEvents = {
    create: async (input: NewPayoutEvent): Promise<PayoutEventRow> => {
      // Field by field, never {...input} — same rule and same reason as payouts.create above.
      const row: PayoutEventRow = {
        id: randomUUID(),
        name: input.name,
        serverId: input.serverId,
        status: "scheduled",
        openMode: input.openMode,
        openAnchor: input.openAnchor,
        openedAt: null,
        closeMode: input.closeMode,
        closeAnchor: input.closeAnchor,
        closedAt: null,
        minMinutes: input.minMinutes ?? 0,
        mapVoteProfile: input.mapVoteProfile ?? null,
        rotationSetId: input.rotationSetId ?? null,
        rotationAppliedAt: null,
        roster: null,
        createdBy: input.createdBy ?? "",
        createdAt: new Date().toISOString(),
        noPayoutAt: null,
        noPayoutBy: null,
      };
      this.payoutEventRows.push(row);
      return { ...row };
    },
    get: async (id: string): Promise<PayoutEventRow | null> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      return row ? { ...row, roster: row.roster ? row.roster.map((r) => ({ ...r })) : null } : null;
    },
    list: async (opts?: { limit?: number; offset?: number }): Promise<PayoutEventRow[]> =>
      this.payoutEventRows.slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50))
        .map((r) => ({ ...r, roster: r.roster ? r.roster.map((x) => ({ ...x })) : null })),
    count: async (): Promise<number> => this.payoutEventRows.length,
    pending: async (): Promise<PayoutEventRow[]> =>
      this.payoutEventRows.filter((e) => e.status === "scheduled" || e.status === "open")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => ({ ...r })),
    applyTransition: async (id: string, t: { openedAt?: string; closedAt?: string; roster?: { playerId: string; name: string | null; minutes: number }[] }): Promise<PayoutEventRow | null> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      if (!row) return null;
      // Status-guarded, mirroring the SQL: a cancelled event stays cancelled and a closed one
      // stays exactly as it closed, whichever of the worker or the API applies first.
      if (t.openedAt && row.status === "scheduled") { row.status = "open"; row.openedAt = t.openedAt; }
      if (t.closedAt && row.status === "open") {
        row.status = "closed";
        row.closedAt = t.closedAt;
        row.roster = t.roster ? t.roster.map((r) => ({ ...r })) : row.roster;
      }
      return { ...row, roster: row.roster ? row.roster.map((r) => ({ ...r })) : null };
    },
    update: async (id: string, patch: PayoutEventPatch): Promise<PayoutEventRow | null> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      // A finished event is a record — mirrors the SQL's status guard.
      if (!row || (row.status !== "scheduled" && row.status !== "open")) return null;
      const fresh = row.status === "scheduled";
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.minMinutes !== undefined) row.minMinutes = patch.minMinutes;
      if (patch.mapVoteProfile !== undefined) row.mapVoteProfile = patch.mapVoteProfile;
      if (patch.rotationSetId !== undefined) row.rotationSetId = patch.rotationSetId;
      if (patch.closeMode !== undefined) row.closeMode = patch.closeMode;
      if (patch.closeAnchor !== undefined) row.closeAnchor = patch.closeAnchor;
      // The open boundary and the server are settled once the event is running (see the patch type).
      if (fresh) {
        if (patch.serverId !== undefined) row.serverId = patch.serverId;
        if (patch.openMode !== undefined) row.openMode = patch.openMode;
        if (patch.openAnchor !== undefined) row.openAnchor = patch.openAnchor;
      }
      return { ...row, roster: row.roster ? row.roster.map((r) => ({ ...r })) : null };
    },
    markRotationApplied: async (id: string, atIso: string): Promise<void> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      if (row && !row.rotationAppliedAt) row.rotationAppliedAt = atIso;
    },
    cancel: async (id: string): Promise<boolean> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      if (!row || (row.status !== "scheduled" && row.status !== "open")) return false;
      row.status = "cancelled";
      return true;
    },
    setNoPayout: async (id: string, mark: { at: string; by: string } | null): Promise<PayoutEventRow | null> => {
      const row = this.payoutEventRows.find((e) => e.id === id);
      // Mirrors the SQL guard: only a finished event can be decided not to pay.
      if (!row || row.status !== "closed") return null;
      row.noPayoutAt = mark?.at ?? null;
      row.noPayoutBy = mark?.by ?? null;
      return { ...row, roster: row.roster ? row.roster.map((r) => ({ ...r })) : null };
    },
    getPostConfig: async (): Promise<EventPostConfig> => ({ ...(this.eventPostConfig ?? EVENT_POST_DEFAULTS) }),
    setPostConfig: async (patch: Partial<EventPostConfig>): Promise<EventPostConfig> => {
      this.eventPostConfig = { ...(this.eventPostConfig ?? EVENT_POST_DEFAULTS), ...patch };
      return { ...this.eventPostConfig };
    },
  };

  crconBans = {
    list: async (query: { serverId?: string } = {}): Promise<CrconBanRow[]> =>
      [...this.crconBansByKey.values()]
        .filter((b) => (query.serverId ? b.serverId === query.serverId : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    upsert: async (input: NewCrconBan): Promise<CrconBanRow> => {
      const key = `${input.serverId}|${input.playerId}|${input.type}`;
      const existing = this.crconBansByKey.get(key);
      const row: CrconBanRow = {
        id: existing?.id ?? randomUUID(), serverId: input.serverId, playerId: input.playerId,
        playerName: input.playerName ?? null, type: input.type, reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null, author: input.author ?? null,
        // The ban's own moment when known, and the EARLIEST known instant wins on re-apply — so a
        // row an older import stamped with the import clock is lowered onto the truth.
        createdAt: [existing?.createdAt, input.bannedAt ?? new Date().toISOString()].filter((x): x is string => !!x).sort()[0]!,
      };
      this.crconBansByKey.set(key, row);
      return row;
    },
    remove: async (serverId: string, playerId: string, type: "temp" | "perma"): Promise<boolean> =>
      this.crconBansByKey.delete(`${serverId}|${playerId}|${type}`),
  };

  matches = {
    open: async (input: { serverId: string; map: string | null; startedAt: string }): Promise<MatchRow> => {
      // Close any still-open match on this server first (a new round supersedes an unfinished one).
      for (const m of this.matchesById.values()) if (m.serverId === input.serverId && !m.endedAt) m.endedAt = input.startedAt;
      // Same identity rule as Postgres's ON CONFLICT (server_id, started_at): re-opening a round
      // we already know reuses its row (and re-opens it) rather than minting a duplicate.
      const existing = [...this.matchesById.values()].find((m) => m.serverId === input.serverId && m.startedAt === input.startedAt);
      if (existing) {
        existing.map = input.map;
        existing.endedAt = null;
        return existing;
      }
      const row: MatchRow = {
        id: randomUUID(), seq: this.nextMatchSeq++, serverId: input.serverId,
        // Mirrors the SQL insert: the game is taken from the server as the round opens.
        game: this.serversById.get(input.serverId)?.game ?? null,
        map: input.map, startedAt: input.startedAt,
        endedAt: null, winner: null, alliedScore: null, axisScore: null, result: null,
        initialMorale: null, alliedMorale: null, axisMorale: null, capFlips: [], moraleHistory: [], matchTime: 0,
        crconMap: null, crconGuessed: null, crconInitialMorale: null, crconEndDeferred: null,
        settledAt: null, sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
        createdAt: new Date().toISOString(),
      };
      this.matchesById.set(row.id, row);
      return row;
    },
    crconRounds: async (serverId: string, limit: number, offset: number): Promise<CrconRoundRow[]> => {
      const from = Math.max(offset, 0);
      return this.crconRoundsOf(serverId).slice(from, from + Math.max(limit, 0));
    },
    crconRoundCount: async (serverId: string): Promise<number> => this.crconRoundsOf(serverId).length,
    crconRoundBySeq: async (serverId: string, seq: number): Promise<{ round: CrconRoundRow; newer: CrconRoundRow | null } | null> => {
      const all = this.crconRoundsOf(serverId);
      const i = all.findIndex((r) => r.seq === seq);
      return i < 0 ? null : { round: all[i]!, newer: i > 0 ? all[i - 1]! : null };
    },
    getOpen: async (serverId: string): Promise<MatchRow | null> =>
      [...this.matchesById.values()].find((m) => m.serverId === serverId && !m.endedAt) ?? null,
    recordTimeline: async (matchId: string, step: { flip?: [number, number, number]; morale?: [number, number, number]; matchTime?: number; initialMorale?: number }): Promise<void> => {
      const m = this.matchesById.get(matchId);
      if (!m) return;
      if (step.flip) m.capFlips = [...m.capFlips, step.flip];
      if (step.morale) m.moraleHistory = [...m.moraleHistory, step.morale];
      if (step.matchTime !== undefined && m.matchTime === 0) m.matchTime = step.matchTime;
      if (step.initialMorale !== undefined && m.crconInitialMorale === null) m.crconInitialMorale = step.initialMorale;
    },
    recordStart: async (matchId: string, start: { map: string; guessed: boolean; matchTime: number; initialMorale: number | null }): Promise<void> => {
      const m = this.matchesById.get(matchId);
      if (!m || m.crconMap !== null) return;
      m.crconMap = start.map;
      m.crconGuessed = start.guessed;
      if (m.matchTime === 0) m.matchTime = start.matchTime;
      if (m.crconInitialMorale === null) m.crconInitialMorale = start.initialMorale;
    },
    recordEnd: async (matchId: string, end: { deferred: boolean }): Promise<void> => {
      const m = this.matchesById.get(matchId);
      if (m && m.crconEndDeferred === null) m.crconEndDeferred = end.deferred;
    },
    crconPlayers: async (matchId: string): Promise<CrconPlayerCache | null> => {
      const cache = this.crconPlayerStats.get(matchId);
      return cache ? structuredClone(cache) : null;
    },
    crconShortRoundPlayers: async (seq: number): Promise<CrconPlayerCache | null> => {
      const players = this.crconShortRounds.get(seq)?.players;
      return players ? structuredClone(players) : null;
    },
    saveCrconPlayers: async (matchId: string, cache: CrconPlayerCache): Promise<void> => {
      if (this.matchesById.has(matchId)) this.crconPlayerStats.set(matchId, structuredClone(cache));
    },
    appendScoreSeries: async (matchId: string, points: ScoreSeriesPoint[]): Promise<void> => {
      if (!this.matchesById.has(matchId)) return;
      const byPlatform = new Map<string, ScoreSeriesPoint>();
      for (const pt of points) byPlatform.set(pt.platformId, pt);
      let round = this.scoreSeriesByMatch.get(matchId);
      for (const pt of byPlatform.values()) {
        const player = this.playersByPlatform.get(pt.platformId);
        if (!player) continue;
        if (!round) this.scoreSeriesByMatch.set(matchId, (round = new Map()));
        const point = [pt.sec, pt.combat, pt.offense, pt.defense, pt.support].map((n) => Math.max(0, Math.round(n)));
        const series = round.get(player.id) ?? [];
        const last = series.slice(-4);
        if (series.length && last.every((v, i) => v === point[i + 1])) continue;
        round.set(player.id, [...series, ...point]);
      }
    },
    scoreSeries: async (matchId: string): Promise<Map<string, number[]>> =>
      new Map([...(this.scoreSeriesByMatch.get(matchId) ?? new Map<string, number[]>())].map(([k, v]) => [k, [...v]])),
    recordScore: async (serverId: string, score: { alliedScore: number; axisScore: number; initialMorale?: number; alliedMorale?: number; axisMorale?: number }): Promise<void> => {
      const open = [...this.matchesById.values()].find((m) => m.serverId === serverId && m.endedAt === null);
      if (!open) return;
      open.alliedScore = score.alliedScore;
      open.axisScore = score.axisScore;
      // Same rule as Postgres's COALESCE: a score-only sample never erases recorded morale.
      if (score.initialMorale != null) open.initialMorale = score.initialMorale;
      if (score.alliedMorale != null) open.alliedMorale = score.alliedMorale;
      if (score.axisMorale != null) open.axisMorale = score.axisMorale;
    },
    close: async (id: string, patch: { endedAt: string; winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; result: string | null }): Promise<MatchRow | null> => {
      const row = this.matchesById.get(id);
      if (!row) return null;
      // Same rule as Postgres: a null score in the patch is "the line said nothing", not "no
      // score", so it must not erase what the sampler recorded — and the winner is then derived
      // from whichever score survives.
      row.endedAt = patch.endedAt;
      row.result = patch.result;
      if (patch.alliedScore !== null) row.alliedScore = patch.alliedScore;
      if (patch.axisScore !== null) row.axisScore = patch.axisScore;
      row.winner = patch.winner ?? scoreWinner(row.alliedScore, row.axisScore);
      return row;
    },
    discardShort: async (id: string, endedAt: string, endedText?: string | null): Promise<boolean> => {
      const row = this.matchesById.get(id);
      if (!row || !(Date.parse(endedAt) - Date.parse(row.startedAt) < MIN_MATCH_MS)) return false;
      if (!this.crconShortRounds.has(row.seq)) {
        this.crconShortRounds.set(row.seq, {
          serverId: row.serverId,
          row: { ...this.crconRoundOf(row), matchId: null, short: true, endedAt: row.endedAt ?? endedAt, result: row.result ?? endedText ?? null, settledAt: null },
          players: this.crconPlayerStats.get(id) ?? null,
        });
      }
      // Mirrors Postgres: take back the credited scores and a settled played/won, then drop the
      // round with its lines and weapon rollups.
      const settled = row.settledAt != null;
      const credited = this.matchScoresCredited.has(id);
      for (const [key, line] of this.matchStatsByKey) {
        if (line.matchId !== id) continue;
        const career = this.statsByPlayer.get(this.statsKey(line.playerId, line.serverId));
        if (career && (settled || credited)) {
          const less = (a: number, b: number) => Math.max(0, a - b);
          if (settled) {
            career.matchesPlayed = less(career.matchesPlayed, 1);
            if (line.won) career.matchesWon = less(career.matchesWon, 1);
          }
          if (credited) {
            career.combat = less(career.combat, line.combat);
            career.offense = less(career.offense, line.offense);
            career.defense = less(career.defense, line.defense);
            career.support = less(career.support, line.support);
            career.vehicleKills = less(career.vehicleKills, line.vehicleKills);
            career.vehiclesDestroyed = less(career.vehiclesDestroyed, line.vehiclesDestroyed);
          }
          career.updatedAt = new Date().toISOString();
        }
        this.matchStatsByKey.delete(key);
      }
      this.matchesById.delete(id);
      this.crconPlayerStats.delete(id);
      this.scoreSeriesByMatch.delete(id);
      this.matchScoresCredited.delete(id);
      this.dropWeaponKills(new Set([id]));
      return true;
    },
    get: async (id: string): Promise<MatchRow | null> => this.matchesById.get(id) ?? null,
    getBySeq: async (seq: number): Promise<MatchRow | null> =>
      [...this.matchesById.values()].find((m) => m.seq === seq) ?? null,
    list: async (serverId: string, limit = 100, offset = 0, beforeIso?: string): Promise<MatchRow[]> => {
      const from = Math.max(offset, 0);
      return [...this.matchesById.values()]
        .filter((m) => m.serverId === serverId && (!beforeIso || m.startedAt < beforeIso))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        .slice(from, from + limit);
    },
    count: async (serverId: string): Promise<number> =>
      [...this.matchesById.values()].filter((m) => m.serverId === serverId).length,
    firstStartedAfter: async (serverId: string, iso: string): Promise<MatchRow | null> => {
      // Date.parse, not string compare: the anchor arrives from user input and need not share
      // the store's ISO formatting.
      const at = Date.parse(iso);
      return [...this.matchesById.values()]
        .filter((m) => m.serverId === serverId && Date.parse(m.startedAt) >= at)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0] ?? null;
    },
    firstEndedAfter: async (serverId: string, iso: string): Promise<MatchRow | null> => {
      const at = Date.parse(iso);
      return [...this.matchesById.values()]
        .filter((m): m is MatchRow & { endedAt: string } => m.serverId === serverId && m.endedAt != null && Date.parse(m.endedAt) >= at)
        .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))[0] ?? null;
    },
    bumpStat: async (input: { matchId: string; playerId: string; serverId: string; playerName?: string | null; side?: "allies" | "axis" | null; kills?: number; deaths?: number; teamkills?: number }): Promise<void> => {
      const key = `${input.matchId}|${input.playerId}`;
      const cur: PlayerMatchStatRow = this.matchStatsByKey.get(key) ?? {
        matchId: input.matchId, playerId: input.playerId, serverId: input.serverId,
        playerName: input.playerName ?? null, side: null, kills: 0, deaths: 0, teamkills: 0,
        combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
        roleSeconds: {}, slSeconds: 0,
        killsAndAssists: 0, killsAndAssistsPrev: 0, deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0, units: [],
        won: null, presentAtEnd: null, updatedAt: new Date().toISOString(),
      };
      cur.kills += input.kills ?? 0;
      cur.deaths += input.deaths ?? 0;
      cur.teamkills += input.teamkills ?? 0;
      if (input.playerName) cur.playerName = input.playerName;
      if (input.side) cur.side = input.side;
      cur.updatedAt = new Date().toISOString();
      this.matchStatsByKey.set(key, cur);
    },
    importScoreboard: async (input: Parameters<Repository["matches"]["importScoreboard"]>[0]): Promise<{ created: boolean; statsApplied: number }> => {
      // Same contract as Postgres: create-if-missing on (serverId, startedAt), fill only blanks
      // on the match, GREATEST on every per-player total — idempotent by construction.
      let match = [...this.matchesById.values()].find((m) => m.serverId === input.serverId && m.startedAt === input.startedAt) ?? null;
      const winner = input.alliedScore !== null && input.axisScore !== null && input.alliedScore !== input.axisScore
        ? (input.alliedScore > input.axisScore ? "allies" as const : "axis" as const) : null;
      let created = false;
      if (!match) {
        // The one-open-round arbiter: an end-less import must not displace a live open match.
        if (!input.endedAt && [...this.matchesById.values()].some((m) => m.serverId === input.serverId && !m.endedAt)) {
          return { created: false, statsApplied: 0 };
        }
        match = {
          id: randomUUID(), seq: this.nextMatchSeq++, serverId: input.serverId,
          game: this.serversById.get(input.serverId)?.game ?? null,
          map: input.map,
          startedAt: input.startedAt, endedAt: input.endedAt, winner,
          alliedScore: input.alliedScore, axisScore: input.axisScore, result: null,
          initialMorale: null, alliedMorale: null, axisMorale: null, capFlips: [], moraleHistory: [], matchTime: 0,
          crconMap: null, crconGuessed: null, crconInitialMorale: null, crconEndDeferred: null,
          sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null, settledAt: null,
          createdAt: new Date().toISOString(),
        };
        this.matchesById.set(match.id, match);
        created = true;
      } else {
        match.alliedScore = match.alliedScore ?? input.alliedScore;
        match.axisScore = match.axisScore ?? input.axisScore;
        match.winner = match.winner ?? winner;
        match.endedAt = match.endedAt ?? input.endedAt;
      }
      let statsApplied = 0;
      for (const p of input.stats) {
        const key = `${match.id}|${p.playerId}`;
        const cur: PlayerMatchStatRow = this.matchStatsByKey.get(key) ?? {
          matchId: match.id, playerId: p.playerId, serverId: input.serverId,
          playerName: null, side: null, kills: 0, deaths: 0, teamkills: 0,
          combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
          roleSeconds: {}, slSeconds: 0,
        killsAndAssists: 0, killsAndAssistsPrev: 0, deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0, units: [],
        won: null, presentAtEnd: null, updatedAt: new Date().toISOString(),
        };
        cur.playerName = cur.playerName ?? p.playerName;
        cur.side = cur.side ?? p.side;
        cur.kills = Math.max(cur.kills, p.kills);
        cur.deaths = Math.max(cur.deaths, p.deaths);
        cur.teamkills = Math.max(cur.teamkills, p.teamkills);
        cur.combat = Math.max(cur.combat, p.combat);
        cur.offense = Math.max(cur.offense, p.offense);
        cur.defense = Math.max(cur.defense, p.defense);
        cur.support = Math.max(cur.support, p.support);
        cur.vehicleKills = Math.max(cur.vehicleKills, p.vehicleKills);
        cur.vehiclesDestroyed = Math.max(cur.vehiclesDestroyed, p.vehiclesDestroyed);
        if (Object.keys(cur.roleSeconds).length === 0) {
          // Real role clocks when the archive carried a unit history; the "-1" sentinel otherwise.
          if (p.roleSeconds && Object.keys(p.roleSeconds).length > 0) cur.roleSeconds = { ...p.roleSeconds };
          else if (p.timeSeconds && p.timeSeconds > 0) cur.roleSeconds = { "-1": Math.round(p.timeSeconds) };
        }
        cur.updatedAt = new Date().toISOString();
        this.matchStatsByKey.set(key, cur);
        statsApplied += 1;
      }
      return { created, statsApplied };
    },
    bumpStatMany: async (inputs: Parameters<Repository["matches"]["bumpStat"]>[0][]): Promise<void> => {
      // As with stats.bumpMany: the loop IS the batch here, so the merge rules can only be the
      // single-row ones. Postgres merges first because a statement cannot hit one row twice.
      for (const i of inputs) if (i.matchId && i.playerId) await this.matches.bumpStat(i);
    },
    statsForMatch: async (matchId: string): Promise<PlayerMatchStatRow[]> =>
      [...this.matchStatsByKey.values()].filter((s) => s.matchId === matchId).sort((a, b) => b.kills - a.kills),
    topStats: async (serverId: string, key: MatchRecordKey, limit = 10): Promise<MatchStatRecord[]> =>
      [...this.matchStatsByKey.values()]
        .filter((s) => s.serverId === serverId && (s[key] ?? 0) > 0)
        .map((s) => ({ s, m: this.matchesById.get(s.matchId) }))
        // Finished rounds only — an open round's numbers are still moving (same rule as Postgres).
        .filter((x): x is { s: PlayerMatchStatRow; m: MatchRow } => Boolean(x.m?.endedAt))
        .sort((a, b) => (b.s[key] ?? 0) - (a.s[key] ?? 0) || b.m.startedAt.localeCompare(a.m.startedAt))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(({ s, m }) => ({
          playerId: s.playerId, playerName: s.playerName ?? null, side: s.side ?? null,
          value: s[key] ?? 0, matchSeq: m.seq, map: m.map, startedAt: m.startedAt,
        })),
    participantCounts: async (serverId: string): Promise<{ matchId: string; players: number }[]> => {
      const counts = new Map<string, number>();
      for (const s of this.matchStatsByKey.values()) {
        if (s.serverId === serverId) counts.set(s.matchId, (counts.get(s.matchId) ?? 0) + 1);
      }
      return [...counts.entries()].map(([matchId, players]) => ({ matchId, players }));
    },
    pendingWeaponRollup: async (limit = 25): Promise<MatchRow[]> =>
      [...this.matchesById.values()]
        .filter((m) => m.endedAt && !this.weaponRollupDone.has(m.id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, Math.min(Math.max(1, limit), 200)),
    saveWeaponRollup: async (matchId: string, rows: { playerId: string; weapon: string; classId: string; kills: number; deaths: number }[]): Promise<void> => {
      const m = this.matchesById.get(matchId);
      if (!m) return;
      for (const [k, r] of this.matchWeaponKills) if (r.matchId === matchId) this.matchWeaponKills.delete(k);
      for (const r of rows) {
        if ((r.kills <= 0 && r.deaths <= 0) || !r.weapon) continue;
        this.matchWeaponKills.set(`${matchId}|${r.playerId}|${r.weapon}`, { matchId, playerId: r.playerId, serverId: m.serverId, weapon: r.weapon, classId: r.classId, kills: r.kills, deaths: r.deaths });
      }
      this.weaponRollupDone.add(matchId);
    },
    classesWithData: async (serverId: string): Promise<string[]> =>
      [...new Set([...this.matchWeaponKills.values()].filter((r) => r.serverId === serverId).map((r) => r.classId))],
    topClassKills: async (serverId: string, classId: string, limit = 10): Promise<ClassKillRecord[]> => {
      // Same fold as Postgres: sum a class's weapons per (round, player), remember the weapon
      // that carried the sum.
      const sums = new Map<string, { matchId: string; playerId: string; value: number; topWeapon: string; topKills: number }>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId !== serverId || r.classId !== classId || r.kills <= 0) continue;
        const key = `${r.matchId}|${r.playerId}`;
        let row = sums.get(key);
        if (!row) { row = { matchId: r.matchId, playerId: r.playerId, value: 0, topWeapon: r.weapon, topKills: 0 }; sums.set(key, row); }
        row.value += r.kills;
        if (r.kills > row.topKills || (r.kills === row.topKills && r.weapon < row.topWeapon)) { row.topKills = r.kills; row.topWeapon = r.weapon; }
      }
      return [...sums.values()]
        .map((r) => ({ r, m: this.matchesById.get(r.matchId) }))
        .filter((x): x is { r: typeof x.r; m: MatchRow } => Boolean(x.m?.endedAt))
        .sort((a, b) => b.r.value - a.r.value || b.m.startedAt.localeCompare(a.m.startedAt))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(({ r, m }) => ({
          playerId: r.playerId, playerName: this.playersById.get(r.playerId)?.name ?? null,
          side: this.matchStatsByKey.get(`${r.matchId}|${r.playerId}`)?.side ?? null,
          value: r.value, weapon: r.topWeapon, matchSeq: m.seq, map: m.map, startedAt: m.startedAt,
        }));
    },
    classTotals: async (serverId: string, classId: string, limit = 10): Promise<{ playerId: string; name: string | null; kills: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.classId === classId && r.kills > 0) sums.set(r.playerId, (sums.get(r.playerId) ?? 0) + r.kills);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([playerId, kills]) => ({ playerId, name: this.playersById.get(playerId)?.name ?? null, kills }));
    },
    weaponSummary: async (serverId: string, limit = 15): Promise<{ weapon: string; classId: string; totalKills: number }[]> => {
      const sums = new Map<string, { classId: string; total: number }>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId !== serverId || r.kills <= 0) continue;
        const row = sums.get(r.weapon) ?? { classId: r.classId, total: 0 };
        row.total += r.kills;
        if (r.classId < row.classId) row.classId = r.classId;
        sums.set(r.weapon, row);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([weapon, v]) => ({ weapon, classId: v.classId, totalKills: v.total }));
    },
    topWeaponKills: async (serverId: string, weapon: string, limit = 10): Promise<MatchStatRecord[]> =>
      [...this.matchWeaponKills.values()]
        .filter((r) => r.serverId === serverId && r.weapon === weapon && r.kills > 0)
        .map((r) => ({ r, m: this.matchesById.get(r.matchId) }))
        .filter((x): x is { r: { matchId: string; playerId: string; serverId: string; weapon: string; classId: string; kills: number; deaths: number }; m: MatchRow } => Boolean(x.m?.endedAt))
        .sort((a, b) => b.r.kills - a.r.kills || b.m.startedAt.localeCompare(a.m.startedAt))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(({ r, m }) => ({
          playerId: r.playerId, playerName: this.playersById.get(r.playerId)?.name ?? null,
          side: this.matchStatsByKey.get(`${r.matchId}|${r.playerId}`)?.side ?? null,
          value: r.kills, matchSeq: m.seq, map: m.map, startedAt: m.startedAt,
        })),
    weaponTotals: async (serverId: string, weapon: string, limit = 10): Promise<{ playerId: string; name: string | null; kills: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.weapon === weapon && r.kills > 0) sums.set(r.playerId, (sums.get(r.playerId) ?? 0) + r.kills);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([playerId, kills]) => ({ playerId, name: this.playersById.get(playerId)?.name ?? null, kills }));
    },
    playerWeaponTotals: async (serverId: string, playerId: string, limit = 10): Promise<{ weapon: string; kills: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.playerId === playerId && r.kills > 0) sums.set(r.weapon, (sums.get(r.weapon) ?? 0) + r.kills);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([weapon, kills]) => ({ weapon, kills }));
    },
    classDeathTotals: async (serverId: string, classId: string, limit = 10): Promise<{ playerId: string; name: string | null; deaths: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.classId === classId && r.deaths > 0) sums.set(r.playerId, (sums.get(r.playerId) ?? 0) + r.deaths);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([playerId, deaths]) => ({ playerId, name: this.playersById.get(playerId)?.name ?? null, deaths }));
    },
    weaponDeathTotals: async (serverId: string, weapon: string, limit = 10): Promise<{ playerId: string; name: string | null; deaths: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.weapon === weapon && r.deaths > 0) sums.set(r.playerId, (sums.get(r.playerId) ?? 0) + r.deaths);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([playerId, deaths]) => ({ playerId, name: this.playersById.get(playerId)?.name ?? null, deaths }));
    },
    playerWeaponDeathTotals: async (serverId: string, playerId: string, limit = 10): Promise<{ weapon: string; deaths: number }[]> => {
      const sums = new Map<string, number>();
      for (const r of this.matchWeaponKills.values()) {
        if (r.serverId === serverId && r.playerId === playerId && r.deaths > 0) sums.set(r.weapon, (sums.get(r.weapon) ?? 0) + r.deaths);
      }
      return [...sums.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.min(Math.max(1, limit), 100))
        .map(([weapon, deaths]) => ({ weapon, deaths }));
    },
    listForPlayer: async (playerId: string, limit = 50): Promise<PlayerMatchRow[]> =>
      [...this.matchStatsByKey.values()]
        .filter((s) => s.playerId === playerId)
        .map((s) => { const m = this.matchesById.get(s.matchId)!; return { ...s, map: m.map, startedAt: m.startedAt, endedAt: m.endedAt, winner: m.winner, seq: m.seq }; })
        .filter((r) => r.startedAt)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit),
    aggregateForPlayer: async (playerId: string): Promise<PlayerMatchAggregate> => {
      const agg: PlayerMatchAggregate = { matches: 0, wins: 0, losses: 0, kills: 0, deaths: 0, teamkills: 0 };
      for (const s of this.matchStatsByKey.values()) {
        if (s.playerId !== playerId) continue;
        const m = this.matchesById.get(s.matchId);
        if (!m || !m.endedAt) continue; // only count finished matches
        agg.matches += 1; agg.kills += s.kills; agg.deaths += s.deaths; agg.teamkills += s.teamkills;
        // Win/loss only when we know both the match winner and the player's side.
        if (m.winner && s.side) { if (s.side === m.winner) agg.wins++; else agg.losses++; }
      }
      return agg;
    },
    participants: async (matchIds: string[]): Promise<PlayerMatchStatRow[]> => {
      const wanted = new Set(matchIds);
      return [...this.matchStatsByKey.values()].filter((s) => wanted.has(s.matchId));
    },
    importOne: async (input: { serverId: string; map: string | null; startedAt: string; endedAt: string | null; winner: "allies" | "axis" | null; result: string | null }): Promise<boolean> => {
      const dup = [...this.matchesById.values()].some((m) => m.serverId === input.serverId && m.startedAt === input.startedAt);
      if (dup) return false;
      const row: MatchRow = {
        id: randomUUID(), seq: this.nextMatchSeq++, serverId: input.serverId,
        // Mirrors the SQL insert: the game is taken from the server as the round opens.
        game: this.serversById.get(input.serverId)?.game ?? null,
        map: input.map, startedAt: input.startedAt,
        endedAt: input.endedAt, winner: input.winner, alliedScore: null, axisScore: null,
        initialMorale: null, alliedMorale: null, axisMorale: null, capFlips: [], moraleHistory: [], matchTime: 0,
        crconMap: null, crconGuessed: null, crconInitialMorale: null, crconEndDeferred: null,
        result: input.result, settledAt: null, sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
        createdAt: new Date().toISOString(),
      };
      this.matchesById.set(row.id, row);
      return true;
    },
    recordSectorLayout: async (input: { serverId: string; layout: string[]; by: string | null }): Promise<MatchRow | null> => {
      const row = [...this.matchesById.values()].find((m) => m.serverId === input.serverId && !m.endedAt);
      if (!row) return null;
      row.sectorLayout = [...input.layout];
      row.sectorLayoutBy = input.by;
      row.sectorLayoutAt = new Date().toISOString();
      return row;
    },
  };

  crconSnapshot = {
    createJob: async (input: NewCrconImportJob): Promise<CrconImportJobRow> => {
      const now = new Date().toISOString();
      const row: CrconImportJobRow = {
        id: randomUUID(), serverId: input.serverId, baseUrl: input.baseUrl, status: "running",
        cursor: {}, counts: {}, errors: [], createdByUserId: input.createdByUserId ?? null,
        createdByName: input.createdByName, createdAt: now, updatedAt: now,
      };
      this.crconJobsById.set(row.id, row);
      this.crconJobKeys.set(row.id, input.apiKey);
      return row;
    },
    getJob: async (id: string): Promise<CrconImportJobRow | null> => this.crconJobsById.get(id) ?? null,
    getJobApiKey: async (id: string): Promise<string | null> => this.crconJobKeys.get(id) ?? null,
    importIntegrity: async (serverId: string) => {
      const cutoff = await this.events.firstLocalTs(serverId);
      const mine = this.evts.filter((e) => e.serverId === serverId && e.dedupeKey?.startsWith("crcon:"));
      const elsewhere = new Set(this.evts.filter((e) => e.serverId !== serverId && e.dedupeKey?.startsWith("crcon:")).map((e) => e.dedupeKey));
      return {
        cutoff,
        // Under `countImportedEvents` the bodies were dropped, so the tally is the counter; the
        // cross-server check below can only run on retained rows and is 0 there by construction.
        importedEvents: this.countImportedEvents ? this.importedEvtCount : mine.length,
        // ra: keys excluded — profile actions carry no server in CRCON, so both servers holding
        // one is expected, not log-store contamination (see the Postgres store's note).
        crossServerEvents: mine.filter((e) => !e.dedupeKey!.startsWith("crcon:ra:") && elsewhere.has(e.dedupeKey)).length,
        preCutoffMatches: [...this.matchesById.values()].filter((m) => m.serverId === serverId && (!cutoff || m.startedAt < cutoff)).length,
        preCutoffSessions: [...this.sessionsByPlayer.values()].flat().filter((s) => s.serverId === serverId && (!cutoff || s.connectedAt < cutoff)).length,
      };
    },
    vipsMovedByImport: async (serverId: string) => {
      // Same rule as the Postgres store (VIP_LAST_SET_CTE there): the newest DELIBERATE setting
      // of a player's expiry — a grant, a group perk's release, a cut (its `after`), or a seed or
      // game reward that granted VIP — is what the row SHOULD say; report it when it says
      // something else and was written after that setting. A grant a perk holds is permanent by
      // design, a dry run set nothing, a reconciler restore only copied the row back to the game,
      // and a cut that removed the VIP stops the row being judged.
      const lastSet = new Map<string, { granted: string | null; at: string; by: string; removed: boolean }>();
      for (const a of this.auditLog) {
        if (a.serverId !== serverId || !a.targetId) continue;
        const d = (a.data ?? {}) as Record<string, unknown>;
        if (d.groupHeld === true || d.dryRun === true || d.reconcile === true) continue;
        const sets = a.action === "vip.grant" || a.action === "vip.group_release" || a.action === "vip.reduce"
          || ((a.action === "seed.reward" || a.action === "game.reward") && "expiration" in d);
        if (!sets) continue;
        const prev = lastSet.get(a.targetId);
        if (prev && a.ts <= prev.at) continue;
        const raw = a.action === "vip.reduce" ? d.after : d.expiration;
        lastSet.set(a.targetId, {
          granted: typeof raw === "string" && raw ? raw : null, at: a.ts, by: a.actorName,
          removed: a.action === "vip.reduce" && d.removed === true,
        });
      }
      const out = [];
      for (const v of this.vipsByKey.values()) {
        if (v.serverId !== serverId || v.groupHold) continue;
        const g = lastSet.get(v.playerId);
        // No surviving setting → unjudgeable, so deliberately not reported (see the type's contract).
        if (!g || g.removed || v.updatedAt <= g.at || v.expiration === g.granted) continue;
        out.push({
          playerId: v.playerId, playerName: v.playerName,
          currentExpiration: v.expiration, grantedExpiration: g.granted,
          grantedAt: g.at, grantedBy: g.by, movedAt: v.updatedAt,
          direction: v.expiration === null ? "made-permanent"
            : g.granted === null ? "given-an-expiry"
            : v.expiration > g.granted ? "extended" : "shortened",
        });
      }
      return out.sort((a, b) => (a.movedAt < b.movedAt ? 1 : -1));
    },
    restoreVipExpirations: async (serverId: string, playerIds: string[]) => {
      const moved = await this.crconSnapshot.vipsMovedByImport(serverId);
      const wanted = new Set(playerIds);
      const done = [];
      for (const m of moved) {
        if (!wanted.has(m.playerId)) continue;
        // Only ever GIVES time back (see the Postgres store): a row cut short, or permanent VIP
        // given an expiry. A longer row is never cut by a restore.
        if (m.direction !== "shortened" && m.direction !== "given-an-expiry") continue;
        const row = this.vipsByKey.get(`${serverId}|${m.playerId}`);
        if (!row || row.groupHold) continue;
        row.expiration = m.grantedExpiration;
        row.updatedAt = new Date().toISOString();
        done.push({ playerId: m.playerId, restoredTo: row.expiration });
      }
      return done;
    },
    importedBreakdown: async (serverId: string) => {
      const cutoff = await this.events.firstLocalTs(serverId);
      const eventsByKind: Record<string, number> = {};
      let profileActionEvents = 0;
      for (const e of this.evts) {
        if (e.serverId !== serverId || !e.dedupeKey?.startsWith("crcon:")) continue;
        // received_actions events share the kicked/banned/message kinds but have no log line
        // behind them — kept apart so a reconciliation compares like with like.
        if (e.dedupeKey.startsWith("crcon:ra:")) { profileActionEvents += 1; continue; }
        eventsByKind[e.kind] = (eventsByKind[e.kind] ?? 0) + 1;
      }
      const matches = [...this.matchesById.values()].filter((m) => m.serverId === serverId && (!cutoff || m.startedAt < cutoff));
      const ids = new Set(matches.map((m) => m.id));
      return {
        cutoff,
        eventsByKind,
        profileActionEvents,
        matches: matches.length,
        matchStats: [...this.matchStatsByKey.values()].filter((s) => ids.has(s.matchId)).length,
        sessions: [...this.sessionsByPlayer.values()].flat()
          .filter((s) => s.serverId === serverId && (!cutoff || s.connectedAt < cutoff)).length,
      };
    },
    purgeServerData: async (serverId: string, opts?: { keepUserHistory?: boolean }) => {
      // Mirrors the Postgres store exactly — see the interface doc for the contract.
      const keep = opts?.keepUserHistory === true;
      const modKinds = new Set(TRIM_CATEGORIES.moderation ?? []);
      const evGoes = (e: EvtRow) => e.serverId === serverId && !(keep && modKinds.has(e.kind));
      const evBefore = this.evts.length;
      for (const e of this.evts) if (evGoes(e) && e.dedupeKey) this.evtDedupe.delete(`${e.serverId}|${e.dedupeKey}`);
      this.evts = this.evts.filter((e) => !evGoes(e));
      const events = evBefore - this.evts.length;

      const gone = [...this.matchesById.values()].filter((m) => m.serverId === serverId);
      const goneIds = new Set(gone.map((m) => m.id));
      for (const m of gone) { this.matchesById.delete(m.id); this.crconPlayerStats.delete(m.id); this.scoreSeriesByMatch.delete(m.id); }
      for (const [k, r] of this.crconShortRounds) if (r.serverId === serverId) this.crconShortRounds.delete(k);
      let matchStats = 0;
      for (const [k, st] of this.matchStatsByKey) if (goneIds.has(st.matchId)) { this.matchStatsByKey.delete(k); matchStats += 1; }
      this.dropWeaponKills(goneIds);

      let sessions = 0;
      for (const [pid, list] of this.sessionsByPlayer) {
        const keep = list.filter((s) => s.serverId !== serverId);
        sessions += list.length - keep.length;
        this.sessionsByPlayer.set(pid, keep);
      }
      for (const k of [...this.openSessions.keys()]) if (k.endsWith(`|${serverId}`)) this.openSessions.delete(k);
      const camBefore = this.adminCamSessions.length;
      this.adminCamSessions = this.adminCamSessions.filter((r) => r.serverId !== serverId);
      const cameraSessions = camBefore - this.adminCamSessions.length;

      let careers = 0;
      if (!keep) for (const [k, st] of this.statsByPlayer) if (st.serverId === serverId) { this.statsByPlayer.delete(k); careers += 1; }
      let bans = 0;
      for (const [k, b] of this.crconBansByKey) if (b.serverId === serverId) { this.crconBansByKey.delete(k); bans += 1; }
      let vips = 0;
      for (const [k, v] of this.vipsByKey) if (v.serverId === serverId) { this.vipsByKey.delete(k); vips += 1; }

      // Player-scoped records go only for players with no presence left ANYWHERE — including the
      // VIP and ban records, which key on the platform id rather than the row id.
      const stillKnown = new Set<string>();
      for (const st of this.statsByPlayer.values()) stillKnown.add(st.playerId);
      for (const [pid, list] of this.sessionsByPlayer) if (list.length) stillKnown.add(pid);
      for (const k of this.openSessions.keys()) stillKnown.add(k.split("|")[0]!);
      for (const c of this.adminCamSessions) if (c.playerId) stillKnown.add(c.playerId);
      for (const e of this.evts) { if (e.actorPlayerId) stillKnown.add(e.actorPlayerId); if (e.victimPlayerId) stillKnown.add(e.victimPlayerId); }
      const byPlatform = new Set<string>([...this.vipsByKey.values()].map((v) => v.playerId));
      for (const b of this.crconBansByKey.values()) byPlatform.add(b.playerId);
      for (const p of this.playersById.values()) if (byPlatform.has(p.platformId)) stillKnown.add(p.id);

      // With keepUserHistory the scrub is skipped outright — notes, tags, IPs, aliases and watch
      // records are user history too (and the kept careers make their owners non-orphans anyway).
      const orphans = keep ? [] : [...this.playersById.keys()].filter((id) => !stillKnown.has(id));
      let notes = 0, tags = 0, ips = 0, aliases = 0, watchlist = 0;
      for (const id of orphans) {
        notes += this.notesByPlayer.get(id)?.length ?? 0; this.notesByPlayer.delete(id);
        tags += this.tagsByPlayer.get(id)?.length ?? 0; this.tagsByPlayer.delete(id);
        aliases += this.aliasesByPlayer.get(id)?.length ?? 0; this.aliasesByPlayer.delete(id);
        if (this.flagsByPlayer.delete(id)) watchlist += 1;
        this.watchHistoryRows = this.watchHistoryRows.filter((w) => w.playerId !== id);
        this.watchReasonRows = this.watchReasonRows.filter((w) => w.playerId !== id);
      }
      const orphanSet = new Set(orphans);
      for (const [k, row] of this.playerIpsByKey) if (orphanSet.has(row.playerId)) { this.playerIpsByKey.delete(k); ips += 1; }

      return { events, matches: gone.length, matchStats, sessions, cameraSessions, careers, bans, vips, notes, tags, ips, aliases, watchlist };
    },
    resetImportedHistory: async (serverId: string) => {
      // Mirrors the Postgres store exactly — see the interface doc for the contract.
      const cutoff = await this.events.firstLocalTs(serverId);
      const before = this.evts.length;
      this.evts = this.evts.filter((e) => {
        const drop = e.serverId === serverId && e.dedupeKey?.startsWith("crcon:");
        // The dedupe index must not outlive the row (in Postgres the constraint IS the row) —
        // otherwise a post-reset re-apply would be silently swallowed instead of rebuilding.
        if (drop && e.dedupeKey) this.evtDedupe.delete(`${e.serverId}|${e.dedupeKey}`);
        return !drop;
      });
      const events = before - this.evts.length;
      const gone = [...this.matchesById.values()].filter((m) => m.serverId === serverId && (!cutoff || m.startedAt < cutoff));
      const goneIds = new Set(gone.map((m) => m.id));
      for (const m of gone) { this.matchesById.delete(m.id); this.crconPlayerStats.delete(m.id); this.scoreSeriesByMatch.delete(m.id); }
      for (const [k, r] of this.crconShortRounds) if (r.serverId === serverId && (!cutoff || r.row.startedAt < cutoff)) this.crconShortRounds.delete(k);
      let matchStats = 0;
      for (const [k, st] of this.matchStatsByKey) if (goneIds.has(st.matchId)) { this.matchStatsByKey.delete(k); matchStats += 1; }
      this.dropWeaponKills(goneIds);
      let sessions = 0;
      for (const [pid, list] of this.sessionsByPlayer) {
        const keep = list.filter((s) => !(s.serverId === serverId && (!cutoff || s.connectedAt < cutoff)));
        sessions += list.length - keep.length;
        this.sessionsByPlayer.set(pid, keep);
      }
      const camBefore = this.adminCamSessions.length;
      this.adminCamSessions = this.adminCamSessions.filter((r) => !(r.serverId === serverId && (!cutoff || r.enteredAt < cutoff)));
      const cameraSessions = camBefore - this.adminCamSessions.length;
      // Career recount from surviving evidence — only the counters imported evidence fed.
      let playersRecounted = 0;
      for (const st of this.statsByPlayer.values()) {
        if (st.serverId !== serverId) continue;
        st.kills = this.evts.filter((e) => e.serverId === serverId && e.actorPlayerId === st.playerId && e.kind === "evt.kill").length;
        st.teamkills = this.evts.filter((e) => e.serverId === serverId && e.actorPlayerId === st.playerId && e.kind === "evt.teamkill").length;
        st.deaths = this.evts.filter((e) => e.serverId === serverId && e.victimPlayerId === st.playerId && (e.kind === "evt.kill" || e.kind === "evt.teamkill")).length;
        st.visits = this.evts.filter((e) => e.serverId === serverId && e.actorPlayerId === st.playerId && e.kind === "evt.player.connected").length;
        st.playtimeSec = (this.sessionsByPlayer.get(st.playerId) ?? []).filter((s) => s.serverId === serverId).reduce((a, s) => a + s.durationSec, 0);
        playersRecounted += 1;
      }
      return { events, matches: gone.length, matchStats, sessions, cameraSessions, playersRecounted };
    },
    latestJob: async (serverId: string): Promise<CrconImportJobRow | null> =>
      [...this.crconJobsById.values()].filter((j) => j.serverId === serverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    listJobs: async (serverId?: string): Promise<CrconImportJobRow[]> =>
      [...this.crconJobsById.values()].filter((j) => (serverId ? j.serverId === serverId : true)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    updateJob: async (id: string, patch: CrconImportJobPatch): Promise<CrconImportJobRow | null> => {
      const cur = this.crconJobsById.get(id);
      if (!cur) return null;
      const next: CrconImportJobRow = {
        ...cur,
        status: patch.status ?? cur.status,
        cursor: patch.cursor ?? cur.cursor,
        counts: patch.counts ?? cur.counts,
        errors: patch.errors ?? cur.errors,
        baseUrl: patch.baseUrl ?? cur.baseUrl,
        updatedAt: new Date().toISOString(),
      };
      if (patch.apiKey !== undefined) this.crconJobKeys.set(id, patch.apiKey);
      this.crconJobsById.set(id, next);
      return next;
    },
  };

  heartbeats = {
    upsert: async (input: { name: string; status: string; detail?: Record<string, unknown> | null }): Promise<HeartbeatRow> => {
      const row: HeartbeatRow = { name: input.name, status: input.status, detail: input.detail ?? null, updatedAt: new Date().toISOString() };
      this.heartbeatsByName.set(row.name, row);
      return row;
    },
    list: async (): Promise<HeartbeatRow[]> => [...this.heartbeatsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };

  /** One matcher for the audit listing and its count, so a total can never disagree with its page. */
  private auditMatches(query: AuditQuery): AuditRow[] {
    const q = query.q?.toLowerCase();
    return this.auditLog.filter((r) => {
      if (query.actorUserId && r.actorUserId !== query.actorUserId) return false;
      if (query.action && r.action !== query.action) return false;
      if (query.actions?.length && !query.actions.includes(r.action)) return false;
      if (query.targetId && r.targetId !== query.targetId) return false;
      if (query.serverId && !(r.serverId === query.serverId || (query.includeUnscoped && r.serverId == null))) return false;
      // A scoped read is "what happened on these servers", so a row with no server is not in it.
      if (query.serverIds && !(r.serverId != null ? query.serverIds.includes(r.serverId) : Boolean(query.includeUnscoped))) return false;
      if (query.from && r.ts < query.from) return false;
      if (query.to && r.ts >= query.to) return false;
      // The flag stored at write time, never re-derived from actorUserId (see AuditQuery.actor).
      if (query.actor === "human" && r.automated) return false;
      if (query.actor === "auto" && !r.automated) return false;
      if (query.actionPrefixes?.length && !query.actionPrefixes.some((pre) => r.action.startsWith(pre))) return false;
      if (query.dataRuleId && (r.data as { ruleId?: unknown } | null)?.ruleId !== query.dataRuleId) return false;
      if (query.dataExpirationSet && typeof (r.data as { expiration?: unknown } | null)?.expiration !== "string") return false;
      if (q && ![r.actorName, r.action, r.summary, r.targetName ?? ""].some((f) => f.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  audit = {
    create: async (input: NewAudit): Promise<AuditRow> => {
      const row: AuditRow = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        actorUserId: input.actorUserId ?? null,
        actorName: input.actorName,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetName: input.targetName ?? null,
        serverId: input.serverId ?? null,
        summary: input.summary,
        data: input.data ?? null,
        // Decided at write time — see the Postgres store for why it is not re-derived later.
        automated: input.actorUserId == null,
      };
      this.auditLog.push(row);
      for (const w of this.auditWatchers) {
        try { w(structuredClone(row)); } catch { /* the row stands whatever a listener does */ }
      }
      return row;
    },
    watch: (listener: (row: AuditRow) => void): (() => void) => {
      this.auditWatchers.add(listener);
      return () => { this.auditWatchers.delete(listener); };
    },
    count: async (query: AuditQuery = {}): Promise<number> => this.auditMatches(query).length,
    get: async (id: string): Promise<AuditRow | null> => {
      const row = this.auditLog.find((r) => r.id === id);
      return row ? structuredClone(row) : null;
    },
    list: async (query: AuditQuery = {}): Promise<AuditRow[]> => {
      // id breaks ts ties so a page boundary can't repeat or drop an entry.
      const dir = query.order === "asc" ? -1 : 1;
      const rows = this.auditMatches(query).sort((a, b) => dir * (b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id)));
      const offset = Math.max(query.offset ?? 0, 0);
      return rows.slice(offset, offset + (query.limit ?? 100));
    },
    vipTimeline: async (cursor: string | null, limit: number, scope: { serverId?: string; before?: string } = {}): Promise<{ rows: AuditRow[]; next: string | null }> => {
      const full = new Set<string>(VIP_TIMELINE_ACTIONS);
      const expiry = new Set<string>(VIP_TIMELINE_EXPIRY_ACTIONS);
      const key = (r: AuditRow) => `${r.ts}|${r.id}`;
      const rows = this.auditLog
        .filter((r) => full.has(r.action) || (expiry.has(r.action) && typeof (r.data as { expiration?: unknown } | null)?.expiration === "string"))
        // Mirrors the Postgres scope: one server's rows plus every resume, older than `before`.
        .filter((r) => !scope.serverId || r.serverId === scope.serverId || r.action === "player.vipresume")
        .filter((r) => !scope.before || Date.parse(r.ts) < Date.parse(scope.before))
        .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
        .filter((r) => cursor === null || key(r) > cursor);
      const page = rows.slice(0, Math.max(1, limit));
      return { rows: page, next: rows.length > page.length ? key(page[page.length - 1]!) : null };
    },
    vipGrantsByRef: async (refs: string[]): Promise<AuditRow[]> => {
      const wanted = new Set(refs);
      return this.auditLog
        .filter((r) => r.action === "vip.grant" && wanted.has(String((r.data as { ref?: unknown } | null)?.ref ?? "")))
        .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    },
    staffSummary: async (range: { from?: string; to?: string; serverIds?: string[]; includeUnscoped?: boolean; actor?: "human" | "auto" } = {}): Promise<StaffSummaryRow[]> => {
      const by = new Map<string, StaffSummaryRow>();
      // One act, one count — mirrors the Postgres store's SQL and the analytics pages'
      // countableActions: continuation rows are skipped, and a bulk volley's per-target rows
      // collapse to one per (actor, action, server, UTC minute).
      const volleys = new Set<string>();
      for (const r of this.auditLog) {
        if (range.from && r.ts < range.from) continue;
        if (range.to && r.ts >= range.to) continue;
        if (range.serverIds && !(r.serverId != null ? range.serverIds.includes(r.serverId) : Boolean(range.includeUnscoped))) continue;
        // The flag stored at write time — NOT actorUserId, which goes null on account deletion.
        if (range.actor === "human" && r.automated) continue;
        if (range.actor === "auto" && !r.automated) continue;
        const d = r.data as { bulk?: unknown; continues?: unknown } | null;
        if (d && "continues" in d) continue;
        const key = r.actorUserId ?? `name:${r.actorName}`;
        if (d?.bulk === true) {
          const volley = `${key}|${r.action}|${r.serverId ?? ""}|${r.ts.slice(0, 16)}`;
          if (volleys.has(volley)) continue;
          volleys.add(volley);
        }
        const s: StaffSummaryRow = by.get(key) ?? { actorUserId: r.actorUserId, actorName: r.actorName, count: 0, lastAt: r.ts, byAction: {} };
        s.count += 1;
        s.byAction[r.action] = (s.byAction[r.action] ?? 0) + 1;
        if (r.ts > s.lastAt) s.lastAt = r.ts;
        by.set(key, s);
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
  };

  pluginKv = {
    get: async (namespace: string, key: string): Promise<unknown> => this.pluginKvByKey.get(`${namespace}|${key}`)?.value,
    set: async (namespace: string, key: string, value: unknown, at?: string): Promise<void> => void this.pluginKvByKey.set(`${namespace}|${key}`, { value, updatedAt: at ?? new Date().toISOString() }),
    remove: async (namespace: string, key: string): Promise<void> => void this.pluginKvByKey.delete(`${namespace}|${key}`),
  };

  /** Nothing is held open: the store is a pile of Maps that the garbage collector deals with. */
  async close(): Promise<void> {}
}
