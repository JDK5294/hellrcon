/**
 * @app/workers — continuous ingestion. For each configured server it connects (in the
 * server's engagement mode; ingestion only ever READS the game), polls the admin log, and
 * feeds new lines through @app/ingest into the event store. Reconnects on failure.
 *
 * This is the always-on counterpart to the API's one-shot `/ingest` endpoint. It holds the
 * persistent RCON connections — the per-server worker model from the architecture.
 */
import { allDataGroups, applyInstallEnv, automationEnabled, bankIfHeld, rewardsRefusedBy, blankMapVoteState, clanGroupOf, clanResolveKey, createRepository, getAppSetting, getFeaturePreset, hasPlaceholders, isAppSettingKey, presetGameMismatch, seedCycleReplayRefusal, seedCycleRetryable, closedApprovalCard, APPROVALS_RELAY_KV_NS, DISCORD_STATUS_BOARD_MIN_SEC } from "@app/db";
import { sweepWeaponRollups } from "./weapon-rollup.js";
import { statSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import type { PlayerTriggerRow, Repository, RuleRow, SeedCycleRecord, SeedFailure, ServerRow, MapVoteStateRow, MapVoteStatePatch, VipGroupHoldSource, VipRow } from "@app/db";

/** One seeder a reward round pays. The skip flags are a RETRY's: the parts already paid. */
type RewardTarget = { playerId: string; name: string; skipVip?: boolean; skipPoints?: boolean; skipBridge?: boolean; retry?: boolean };
import { createEventBus, type EventBus } from "@app/bus";
import { ingestLines } from "@app/ingest";
import { createServerClient, messageEveryone, rosterPlayers, normalizeGameBans, normalizeGameVips, normalizeSession, queueDepth, vipQueueDepth, RconCommandError, RconConnectionError } from "@app/rcon-core";
import { classifyWeapon, getGame, playerIdentityOf, resolveTeamSides, rosterPlayerId, stateReaderFor, summarizeRoster, teamSidesConfident, type SessionHeadcounts } from "@app/games";
import { appendWelcomeSignature, automatedSignerFrom, background, createLogger, discordLiteral, restoreInProgress, fillPlayerToken, installCrashHandlers, repeatEvery, type Logger } from "@app/shared";
import { pollMapWatchStep, type PollMapWatch } from "./mapvote-watch.js";
import { planSeedingTick, joinsSince, seedingNews, seedActionAudit, enforcementSides, forgetSidesOnNewMap, bridgeAccountFor, bridgeBonusLine, calcRewardExpiration, composeRewardMessage, formatVipUntil, pointsSkipReason, resolveContainZone, rewardPhrase, rosterIdOf, rosterPosOf, seedCheckDelayMs, seedPaidPlayers, seedWindowLabel, splitRepeatSeeders, applyVars, type AxisCalState, type EscalationState, type Phase, type SeedRosterPlayer } from "./seeding.js";
import { annotateVip, autoSettingsDuty, dueRosterTriggerFirings, dueStateFirings, pruneRosterTriggerMemory, pruneStateFiredAt, rosterToRulePlayer, rosterTriggerWatchesFor, stampDiscord, stampOnline, stampPlayMinutes, stampPlaytime, stateRulesFor, type StateRuleReport } from "./state-rules.js";
import { CLAN_TAG_KIND, KILL_RATE_KIND, NO_DISCORD_KIND, NO_VIP_KIND, OUT_OF_ZONE_KIND, PLAYER_TRIGGER_ROSTER_KIND, PLAYTIME_KIND, isPlayerRosterEvent, playtimeKey, resolveTriggerParams, type ZoneCellSets } from "@app/rules";
import { buildPoll, describeMaps, describeMap, resolveActivePool, resolvePinnedPool, resolveCurrentMapId, resolveRoundResult, resolveVoteWinner, replayGuardPick, replayQueued, scheduleNextMap, buildVoteAnnouncement, shouldApplyLiveLeader, zoneKeyOf, learnedLayoutOf, layerZoneKey, type LearnedLayout, type CurrentMapCatalogueItem, type MapVoteProfile, type RotationIO, type VoteMessageLayout } from "@app/maps";
import { isWindowActive, matchMinutesSince, resolveProfile, type ScheduleSpec, type ScheduleWindow } from "@app/schedule";
import { dueMatchMessages, sentMatchMessageKeys } from "./match-messages.js";
import { buildEventsPost, dueEventsPost, sweepPayoutEvents } from "@app/payout";
import { CombinedVoteSurface, InGameChatVote, NativeDiscordPoll, discordMessageIdOf, listIngameVoters, spareForSiblingVotes, ttlMemo, type SiblingVoteState, type VoteSurface } from "./vote-surface.js";
import { postMessage, postEmbedTracked, deleteMessage, editMessage, editText, postMessageTracked, sweepOwnMessages, channelsToSweep, buildPausedEmbed } from "./discord-poll.js";
import { buildStatusEmbed } from "./status-board.js";
import { loadMapArt, loadEmblem, loadScoreIcons, loadBoardLogo, nationsFor } from "./map-art.js";
import { QuietFailures, forDuration } from "./quiet-failure.js";
import { planAutoBackup, autoBackupFileName } from "./auto-backup.js";
import { readVipExpiryPlan } from "./vip-expiry.js";
import { applyEventRotations, resumeLapsedVipPauses, sweepExpiredConsoleAdmins, type ServerSweepDeps } from "./server-sweeps.js";
import { RECONCILE_MAX_SENDS, StuckWrites, namesOf, reconcileMode } from "./reconcile-mode.js";
import { desiredHolds, describeSpan, expiringSoon, perkWritable, planPerkHolds, type PerkGroup, type PerkNotes } from "./group-perks.js";
import { reapEndAt } from "./session-reap.js";
import { crconRoundPass } from "./crcon-round.js";
import { SCORE_CHECK_MS, scoreCheck, stepHasNews, waitCheckingScore } from "./score-check.js";
import { shareLiveReadsOn, shareRotationIfDue, sharingLiveReads } from "./live-share.js";
import { logBacktrackSec } from "./log-window.js";
import { crconDetailedPlayer, recordCrconPlayers, type CrconDetailedPlayer } from "./crcon-players.js";
import { SCORE_SERIES_MS, scoreSeriesPoints } from "./score-series.js";
import { singleFlight, whilePaused } from "./sweeps.js";
import { clearLapsedVoteHold } from "./vote-hold.js";
import { runPresetLeftovers } from "./preset-leftovers.js";

/**
 * One tracker for every repeating job in this process, keyed by "<job>:<serverId>".
 *
 * These jobs all catch their own errors so a bad read cannot take down the loop they ride on, and
 * they all used to log that at `debug` — invisible at the default level. A job that stopped
 * working therefore said nothing, which is how a stats pipeline can quietly stop counting.
 */
const quiet = new QuietFailures();
// The board's data contract, NOT board-image.js: that module loads the native canvas library
// (~33 MB resident) and this process only describes boards — the drawing happens in the render
// thread. board-contract.test.ts holds this import to the canvas-free module.
import { EMPTY_TOTALS, type BoardImageInput, type Leader, type SideTotals } from "./board-contract.js";
import { renderBoardOffThread } from "./board-render.js";
import { driveImportJobs } from "./crcon-import/runner.js";
import { buildNudgeMessage, nudgePings, splitUnread } from "./nudge.js";
import { syncDiscordRoles } from "./discord-role-sync.js";
import { syncGroupRoles } from "./group-roles.js";
import { createSupervisor, connectionFingerprint, type RunnerControl } from "./supervisor.js";

import { planVipReconcile, vipReconcileSignature } from "@app/rcon-core";
import { planBanReconcile, reconcileSignature, serverTimezone } from "@app/db";
import type { GameBanLite } from "@app/db";
import { driftSignature, extractSettingValue, settingsDrift, writeOnlySettings } from "./settings-drift.js";
import { runLayoutExpiryTick } from "./layout-expiry.js";
import { welcomeNeedsWrite } from "./welcome.js";
import { KillStreakTracker, dayIn } from "./game-rewards.js";
import { gameRewardsCache, gameRewardsFor, payGameReward, platformOf, playersOnline, reconnecting, rewardDayStreak, rewardMatchEnded, rewardSeedDay } from "./game-rewards-pay.js";
import { rendererFor } from "./renderer.js";
import { freshHealth, onPollOk, onPollFail, type ServerHealthEmit } from "./server-health.js";

const log = createLogger("worker");

const POLL_MS = Number(process.env.INGEST_POLL_MS ?? 10_000);
/** How far the first log read after a (re)connect reaches back, so a restart or a dropped
 *  connection does not silently discard everything the game logged in between. Ten minutes
 *  covers an update restart with room to spare; longer gaps still lose lines, but the loss is
 *  then a fact about the outage, not about the first poll's window. */
const RECONNECT_BACKFILL_SEC = Number(process.env.LOG_BACKFILL_SEC ?? 600);
const RECONNECT_MS = Number(process.env.INGEST_RECONNECT_MS ?? 15_000);
// How long a server may be unanswered before the "server unreachable" alert fires (server-health.ts).
const SERVER_DARK_MS = Number(process.env.SERVER_DARK_MS ?? 180_000);
const RESCAN_MS = Number(process.env.INGEST_RESCAN_MS ?? 60_000);
const VIP_SWEEP_MS = Number(process.env.VIP_SWEEP_MS ?? 120_000);
const BAN_RECONCILE_MS = Number(process.env.BAN_RECONCILE_MS ?? 300_000);
/** How often group VIP perks are reconciled against group membership. A member added or removed
 *  is held or released within about this long, whichever way the membership changed. */
const GROUP_PERK_MS = Number(process.env.GROUP_PERK_MS ?? 60_000);
/** How often groups linked to a community Discord role are brought in step with it. A role
 *  granted or taken in Discord moves the group within about this long. */
const GROUP_ROLE_SYNC_MS = Number(process.env.GROUP_ROLE_SYNC_MS ?? 300_000);
/** Payout event boundary sweep. A minute is tight enough — the boundaries resolve to their
 *  scheduled times regardless of when the sweep runs, so cadence is about display freshness. */
const PAYOUT_EVENT_SWEEP_MS = Number(process.env.PAYOUT_EVENT_SWEEP_MS ?? 60_000);
/** Class-kill rollup cadence and batch: 20 rounds a minute clears a fresh whistle instantly and
 *  backfills a year of history in a few hours, without the sweep ever being a load spike. */
const CLASS_ROLLUP_MS = Number(process.env.CLASS_ROLLUP_MS ?? 60_000);
const LAYOUT_EXPIRY_MS = Number(process.env.LAYOUT_EXPIRY_MS ?? 60_000);
/** What the removed objective presets may have left to put back (preset-leftovers.ts). Nothing makes
 *  new work for it, and it stops for good once there is none. */
const PRESET_LEFTOVERS_MS = Number(process.env.PRESET_LEFTOVERS_MS ?? 60_000);
const CLASS_ROLLUP_BATCH = 20;
const SEED_POLL_MS = Number(process.env.SEED_POLL_MS ?? 30_000);
/** The seeding loop's CHASE cadence — used only while the server is seeding AND a rule that
 *  chases players around the map (cap fight, containment) is armed. See seedTickDelayMs. */
const SEED_FAST_POLL_MS = Number(process.env.SEED_FAST_POLL_MS ?? 10_000);

const RECENT_MAPS_MEMORY = 20;
const MAPVOTE_POLL_MS = Number(process.env.MAPVOTE_POLL_MS ?? 30_000);
/** how often an open vote re-reads the map in play, to catch a match end the log never reported. */
/** how long a layer's learned layout is reused before it is re-read (votes arrive once a round). */
const LAYOUT_CACHE_MS = 5 * 60_000;
/** an unchanged status row is still rewritten this often, so its timestamp never goes stale. */
const STATE_HEARTBEAT_MS = 5 * 60_000;
const MISSED_END_CHECK_MS = Number(process.env.MAPVOTE_MISSED_END_CHECK_MS ?? 60_000);
/**
 * How recent a round end must be for the vote to act on it with no ballot up. Its only purpose is
 * to queue a map before the next one loads; an end read later than this is a backlog (voting just
 * switched back on, the worker back from downtime) whose next map loaded long ago. Measured against
 * the game's own log timestamp, so it is generous enough to absorb a server clock a little off.
 */
const FRESH_ROUND_END_MS = 10 * 60_000;
/** A session that only a reconnect can heal: wedged, or a socket that is gone. The game ANSWERING
 *  "no" (RconCommandError, a subclass of the connection error) is not one. */
const isDeadSession = (e: unknown): boolean =>
  e instanceof RconSessionWedgedError || (e instanceof RconConnectionError && !(e instanceof RconCommandError));
const BROADCAST_IDLE_MS = Number(process.env.BROADCAST_IDLE_MS ?? 15_000); // re-check cadence when idle/waiting
const AUTOSETTINGS_POLL_MS = Number(process.env.AUTOSETTINGS_POLL_MS ?? 30_000);
/** How long one read of recorded playtime serves the playtime trigger (it moves only on disconnect). */
const PLAYTIME_CACHE_MS = 5 * 60_000;
/**
 * How often an ACTIVE profile's settings are checked against the server and re-applied on drift.
 * Its own knob, deliberately not the runner's tick: the tick also paces the player rules, so
 * slowing it to make enforcement gentler would slow no-leader warnings with it. Five minutes
 * default — a wipe is a rare event, and the repair being minutes rather than seconds late costs
 * nothing, while checking six getters every thirty seconds forever buys nothing.
 */
const AUTOSETTINGS_ENFORCE_MS = Number(process.env.AUTOSETTINGS_ENFORCE_MS ?? 300_000);
const CRCON_IMPORT_SCAN_MS = Number(process.env.CRCON_IMPORT_SCAN_MS ?? 20_000);
const ANNOUNCE_NUDGE_MS = Number(process.env.ANNOUNCE_NUDGE_MS ?? 600_000); // unread-notice check cadence
// The events post fires on a time of day, so minutes of slack cost nothing — see postEventsList.
const EVENTS_POST_MS = Number(process.env.EVENTS_POST_MS ?? 300_000);
// How often the server's SHAPE is sampled. Slower than the log poll on purpose: composition drifts
// over minutes, not seconds, and every sample is a row kept for as long as the history is wanted.
const ROSTER_SNAPSHOT_MS = Number(process.env.ROSTER_SNAPSHOT_MS ?? 60_000);
/** How long an open session may be absent from the live roster before the reaper closes it —
 *  see closeAbsent. Longer than one snapshot interval, so one missed poll never logs anyone out. */
const SESSION_REAP_GRACE_MS = Number(process.env.SESSION_REAP_GRACE_MS ?? 180_000);
/** How often a server may report unrecognised admin-log lines (see the report site for why). */
const UNPARSED_REPORT_MS = Number(process.env.UNPARSED_REPORT_MS ?? 300_000);
// The bot token and the staff guild are set in the panel (Discord → Setup & status) and copied into
// this process's environment on a timer (install-env.ts), so they are read when used rather than once
// at start: a token saved in the panel reaches the worker without a restart.
const discordToken = (): string => process.env.DISCORD_TOKEN ?? "";
const discordGuildId = (): string => process.env.DISCORD_GUILD_ID ?? ""; // the staff guild — the same setting the API's gates use
/** How often the settings saved in the panel are read into this process. */
const INSTALL_ENV_MS = Number(process.env.INSTALL_ENV_MS ?? 30_000);
const DISCORD_ROLE_SYNC_MS = Number(process.env.DISCORD_ROLE_SYNC_MS ?? 300_000); // staff-role resync cadence
const AUTO_BACKUP_SWEEP_MS = Number(process.env.AUTO_BACKUP_SWEEP_MS ?? 300_000); // how often "is the nightly backup due" is asked — not how often one runs
// Set INGEST_DEBUG=1 (in infra/.env) to dump the raw GetAdminLog response + extracted lines
// once per connection — used to tune the admin-log parsing/normalizer against a real server.
const DEBUG = process.env.INGEST_DEBUG === "1" || process.env.INGEST_DEBUG === "true";


/** One place to build + connect a server's game client (same helpers as the API). Its reads of the
 *  session, roster and rotation are also left for the panel's Live page (live-share.ts). */
function gameClientFor(server: ServerRow) {
  return sharingLiveReads(createServerClient({ protocol: server.protocol, engagementMode: server.engagementMode, commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey }), server.id);
}
/**
 * Every dial the worker makes goes through here, which makes it the one place that can remember
 * whether a server actually answers — see `recordContact`. Recording at the choke point rather than
 * at the ten call sites is deliberate: health that depends on each caller remembering to report is
 * health that goes missing exactly when a new call site is added.
 *
 * The bookkeeping never changes the outcome: a failed connect still throws the original error, and
 * a failure to WRITE the health row is swallowed, because losing a status update must not turn a
 * working server into a broken one.
 *
 * `timeoutMs` bounds the dial and every exchange after it; omitted, the client's own default.
 */
async function connectGameClient(client: ReturnType<typeof createServerClient>, server: ServerRow, timeoutMs?: number) {
  try {
    const result = await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined, timeoutMs });
    void healthRepo?.servers.recordContact(server.id, { ok: true }).catch(() => {});
    return result;
  } catch (err) {
    void healthRepo?.servers.recordContact(server.id, { ok: false, error: (err as Error).message }).catch(() => {});
    throw err;
  }
}
/** Set once at startup so the connect helper can record health without threading a repo through
 *  every runner's signature. */
let healthRepo: Repository | null = null;

/**
 * A runner whose automation is switched off for this server parks instead of running.
 *
 * Parking rather than returning keeps the supervisor's model simple — a runner runs until told to
 * stop — and the switch being part of the connection fingerprint means flipping it restarts the
 * runners, so the parked loop wakes up as a working one (and vice versa) within a rescan.
 */
async function parkDisabled(ctl: RunnerControl): Promise<void> {
  while (!ctl.stopped) await ctl.sleep(60_000);
}

/**
 * Tell the server an admin is watching (or has stopped), if this server asked for that.
 *
 * Off by default and per-server, because it is a policy choice: some communities want players to
 * know they are being observed, others consider that the opposite of what a camera is for.
 *
 * A blank message means "say nothing for that half", which is how you announce the entry without
 * announcing the exit. Failures are logged and swallowed — an announcement that did not go out is
 * a smaller problem than an ingest loop that reconnects because of it.
 */
async function announceAdminCam(
  repo: Repository, server: ServerRow, client: ReturnType<typeof gameClientFor>,
  events: { name: string; entered: boolean }[], slog: ReturnType<typeof log.child>,
): Promise<void> {
  if (server.engagementMode !== "active") return; // observe mode never writes to the game
  const cfg = await repo.adminCam.getConfig(server.id).catch(() => null);
  if (!cfg?.notifyEnabled) return;
  for (const e of events) {
    const template = e.entered ? cfg.enterMessage : cfg.exitMessage;
    // The in-game name off the CAMERA log line — see fillPlayerToken for why this is not, and
    // cannot yet be, the staff member's Discord name.
    const message = fillPlayerToken(template, e.name);
    if (!message) continue;
    try { await client.execute("broadcast", { message: await rendererFor(repo, server, client).render(message) }); }
    catch (err) { slog.warn("could not tell players an admin entered the camera — the announcement is configured but did not send", { server: server.name, err: (err as Error).message }); }
  }
}

async function ingestServer(repo: Repository, bus: EventBus, server: ServerRow, ctl: RunnerControl): Promise<void> {
  const seen = new Set<string>();
  // Kill streaks for game rewards — per server, across reconnects; a new match resets every run.
  const killStreaks = new KillStreakTracker();
  // Dark/recovered latch: survives reconnect cycles (declared out here, not per-connection), so
  // one outage is one alert however many times the loop retries underneath it.
  let health = freshHealth();
  const emitHealth = (emit: ServerHealthEmit) => {
    if (!emit) return;
    bus.emit(emit.kind === "dark" ? "app.server.dark" : "app.server.recovered", {
      kind: emit.kind === "dark" ? "app.server.dark" : "app.server.recovered",
      serverId: server.id, ts: new Date().toISOString(), data: { minutes: emit.downMinutes },
    });
  };
  // The game module owns log-line identity + parsing; fall back to raw-line identity for games
  // without a module (parsing then stores nothing, which is the correct degrade).
  const mod = getGame(server.game);
  const lineKey = mod?.logLineKey ?? ((l: string) => l);
  let lastSnapshotMs = 0;
  // The last roster read that actually succeeded for this server — how far a stranded session may
  // honestly be said to have run (see session-reap.ts). Survives reconnects; null until the first.
  let lastObservedAt: string | null = null;
  let lastBoardMs = 0;
  let lastUnparsedMs = 0;
  // CRCON's recorder carries the elapsed time it last returned into the next pass (cap-flips.ts).
  let timelineElapsed = 0;
  // When the open round's players last got a score-series point (score-series.ts).
  let lastSeriesMs = 0;
  while (!ctl.stopped) {
    const client = gameClientFor(server);
    const slog = log.child({ serverId: server.id, server: server.name, host: server.host, port: server.port });
    try {
      await connectGameClient(client, server);
      slog.info("ingesting server");
      let dumpedRaw = false;
      // The FIRST read of a connection reaches back much further than a normal poll. The narrow
      // backtrack was applied from the very first tick, so every restart or dropped connection
      // silently discarded whatever the game logged in between — and a MATCH ENDED lost that way
      // is a round closed with no result, which is where the analytics page's "ended with no
      // recorded result" rounds were coming from. Re-reading a big window is free by the
      // pipeline's own guarantees: lines dedupe by stable key, events dedupe in the store, and
      // ingestLines is replay-safe. The stale-whistle guard in @app/ingest keeps an END from
      // before an unseen round from closing the wrong match.
      let firstRead = true;
      // When the last read that got through was sent: the next one reaches back to it (log-window.ts).
      let previousReadAt = 0;
      while (!ctl.stopped) {
        // The fast half of the restore stand-down: the rescan stops this runner within a minute,
        // but ingestion is the writer whose rows actually corrupt a restore, so it pauses itself
        // within one poll of the marker appearing. The connection idles; nothing is read or
        // written until the marker clears or the rescan stops the loop.
        if (restoreInProgress()) { await ctl.sleep(POLL_MS); continue; }
        const backtrack = firstRead ? RECONNECT_BACKFILL_SEC : logBacktrackSec(Date.now() - previousReadAt, POLL_MS, RECONNECT_BACKFILL_SEC);
        // One-time raw dump per connection: the actual GetAdminLog wire shape drives how we
        // extract lines and tune the normalizer. Share this output to get parsing tuned.
        if (DEBUG && !dumpedRaw) {
          dumpedRaw = true;
          try {
            const raw = await client.execute("getAdminLog", { seconds: backtrack });
            slog.info("DEBUG raw GetAdminLog response (share this)", { raw: JSON.stringify(raw).slice(0, 4000) });
          } catch (e) {
            slog.warn("DEBUG raw GetAdminLog call failed", { err: (e as Error).message });
          }
        }
        const readAt = Date.now();
        const lines = await client.readLogLines(backtrack); // throws if the connection died → reconnect
        firstRead = false; // only a read that SUCCEEDED spends the backfill; a throw retries it
        previousReadAt = readAt;
        // A read got through — the server is answering. Records the clock, and emits recovery if
        // this is the first success after a dark alert.
        { const r = onPollOk(health, Date.now()); health = r.state; emitHealth(r.emit); }
        if (DEBUG) slog.info("DEBUG extracted log lines", { count: lines.length, sample: lines.slice(0, 25) });
        // Dedup on a stable key: the same event reappears each poll with a different relative
        // time in its prefix, so the raw string changes but logLineKey stays constant.
        const fresh = lines.filter((l) => !seen.has(lineKey(l)));
        for (const l of fresh) seen.add(lineKey(l));
        // Trim the OLDEST half rather than dumping the whole set: a full clear meant the next
        // tick re-parsed ~15s of already-stored lines (the DB dedup made it harmless, but it was
        // wasted work every ~25min on a busy server). Set iteration is insertion order, which
        // here is arrival order — so the front of the set is exactly the stale half.
        if (seen.size > 5000) {
          let drop = seen.size - 2500;
          for (const k of seen) { if (drop-- <= 0) break; seen.delete(k); }
        }
        if (fresh.length > 0) {
          // Publish each newly-stored event onto the bus so the API's plugins react to live
          // activity. ingestLines only calls this for genuinely new events (never duplicates).
          //
          // Admin-camera lines are collected on the way past for the in-game announcement. That
          // "genuinely new" guarantee is what makes this safe: the worker re-reads the last ~15s
          // of admin log on every poll and again after a reconnect, and announcing from the raw
          // batch would tell the server the same admin entered cam over and over.
          const camEvents: { name: string; entered: boolean }[] = [];
          // Game rewards ride the same "genuinely new" guarantee: a kill streak or a match end is
          // seen once, never again on a re-read window.
          const rewardCfg = await gameRewardsFor(repo, server.id);
          const streakTiers = rewardCfg?.killStreaks.enabled ? rewardCfg.killStreaks.tiers : null;
          const streakHits: { recordId: string; kills: number; lifeRef: string; weapon: string | null; victim: string | null }[] = [];
          const matchEnds: string[] = [];
          const n = await ingestLines(repo, server.id, fresh, (evt) => {
            bus.emit(evt.kind, evt);
            if (evt.kind === "evt.match.started") killStreaks.reset();
            else if (evt.kind === "evt.match.ended") matchEnds.push(evt.ts);
            else if (evt.kind === "evt.kill" || evt.kind === "evt.teamkill") {
              if (evt.victimPlayerId) killStreaks.death(evt.victimPlayerId);
              if (evt.kind === "evt.kill" && evt.actorPlayerId && streakTiers) {
                for (const hit of killStreaks.kill(evt.actorPlayerId, evt.ts, streakTiers)) streakHits.push({ recordId: evt.actorPlayerId, ...hit, weapon: evt.weapon ?? null, victim: evt.victimName ?? null });
              }
            }
            if (evt.kind !== "evt.admin.camera") return;
            const entered = (evt.data as { entered?: boolean | null } | null)?.entered;
            if (typeof entered === "boolean") camEvents.push({ name: evt.actorName ?? "An admin", entered });
          }, server.game, (warning) => slog.warn("ingest stored a batch less fully than it could", { warning }));
          if (camEvents.length) await announceAdminCam(repo, server, client, camEvents, slog);
          // Never let a reward stall ingestion: each is caught and logged on its own.
          for (const hit of streakHits) {
            const cfg = rewardCfg!.killStreaks;
            const tier = cfg.tiers.find((t) => t.kills === hit.kills);
            const who = tier ? await platformOf(repo, hit.recordId) : null;
            if (!tier || !who) continue;
            // A near-empty server is not a streak worth paying: two players trading kills in a
            // seeding lull would farm it. Unknown count (a read failed) does not block a reward.
            if (cfg.minPlayers > 0) {
              const online = await playersOnline(server.id, client);
              if (online !== null && online < cfg.minPlayers) continue;
            }
            await payGameReward(repo, server, client, slog, {
              kind: "killStreak", ref: `streak:${hit.recordId}:${hit.lifeRef}:${hit.kills}`, platformId: who.platformId, name: who.name,
              reward: tier.reward, dryRun: cfg.dryRun, message: tier.message?.trim() || cfg.message,
              vars: { streak: hit.kills, weapon: hit.weapon ?? "", victim_name: hit.victim ?? "" }, what: `${hit.kills}-kill streak`,
            }).catch((err) => slog.warn("kill-streak reward failed", { err: (err as Error).message }));
          }
          // Match-end rewards can pay a full server (a VIP write and a message each), so they run
          // on their own short connection in the background — ingestion never waits on them.
          for (const endedAt of matchEnds) {
            if (!rewardCfg?.topStats.enabled && !rewardCfg?.matchEnd.enabled) continue;
            void (async () => {
              const rc = gameClientFor(server);
              try {
                await connectGameClient(rc, server);
                // Both kinds together, so a player who earns several gets ONE message. Through a
                // client that reconnects: the game drops RCON around the map change, mid-payout.
                const sturdy = reconnecting(rc, async () => { await rc.disconnect().catch(() => {}); await connectGameClient(rc, server); }, slog);
                await rewardMatchEnded(repo, server, sturdy, slog, endedAt);
              } catch (err) {
                slog.warn("match-end rewards could not connect", { err: (err as Error).message });
              } finally {
                await rc.disconnect().catch(() => {});
              }
            })();
          }
          if (n === 0) {
            // n===0 has two very different causes. After a worker restart the in-memory `seen`
            // set is empty, so we re-read the last ~15s of admin log — lines already stored;
            // the DB dedup correctly skips them (no double-count). That's NOT a normalizer bug.
            // Only warn when nothing in the batch even PARSED — the genuine "needs tuning" case.
            const anyParsed = fresh.some((l) => mod?.normalizeLine(l, { serverId: server.id }) != null);
            if (!anyParsed) slog.warn("read log lines but none parsed into events — normalizer needs tuning", { lines: fresh.length, sample: fresh.slice(0, 5) });
            else slog.debug("batch fully deduplicated (already stored)", { lines: fresh.length });
          } else slog.debug("ingested batch", { events: n });
          /*
           * Say when SOME lines did not parse, not only when none did.
           *
           * The check above answers "is the normalizer completely broken", and a completely
           * broken normalizer is the easy case — somebody notices within the hour. The case that
           * actually cost us was one line shape in a hundred going unread: kills and chat kept
           * flowing, every dashboard looked alive, and admin-camera visits silently recorded
           * nothing for as long as the gap existed. Nothing in the system was obliged to mention
           * it. Now something is.
           *
           * Throttled to one report per server per interval so a game that legitimately emits
           * chatter we do not model cannot turn this into a log flood — and so the second parse
           * pass it costs happens once every few minutes rather than on every poll.
           */
          if (Date.now() - lastUnparsedMs >= UNPARSED_REPORT_MS) {
            const unparsed = fresh.filter((l) => mod?.normalizeLine(l, { serverId: server.id }) == null);
            if (unparsed.length) {
              lastUnparsedMs = Date.now();
              slog.warn("some admin-log lines were not recognised — these are events the panel will never show", {
                unparsed: unparsed.length,
                of: fresh.length,
                sample: unparsed.slice(0, 5),
              });
            }
          }
        }
        // The panel's Live page shows the map rotation from the worker's reads too (live-share.ts).
        await shareRotationIfDue(client, server.id);
        // The round as CRCON's map recorder keeps it (crcon-round.ts): filed under a layer id as it
        // starts, its score timeline, and its end. CRCON's current map is the newest round, ended or
        // not. One session read per pass, only on Hell Let Loose servers. It must never stop ingest;
        // a failed read decides nothing and is retried.
        if (server.game === "hll" || server.game === "hllv") {
          try {
            const [round] = await repo.matches.list(server.id, 1, 0);
            if (round) {
              const sess = normalizeSession(await client.readState("session"));
              const pass = crconRoundPass(round, round.game ?? server.game, Date.now(), sess, timelineElapsed);
              if (pass.start) await repo.matches.recordStart(round.id, pass.start);
              const step = pass.step;
              if (stepHasNews(step)) await repo.matches.recordTimeline(round.id, step);
              if (pass.end) await repo.matches.recordEnd(round.id, pass.end);
              timelineElapsed = pass.elapsed;
              // The same pass records the round's players (crcon-players.ts), off the roster as it
              // stands now. A roster that cannot be read leaves the cache as it was, and nothing
              // here may undo the round's own records above.
              if (step?.recorded) {
                try {
                  const raw = await client.readState("players");
                  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { players?: unknown[] })?.players) ? (raw as { players: unknown[] }).players : null;
                  if (list) {
                    const game = round.game ?? server.game;
                    const players = new Map<string, CrconDetailedPlayer>();
                    for (const pl of list as Record<string, unknown>[]) {
                      const who = playerIdentityOf(mod, pl);
                      if (who) players.set(who.platformId, crconDetailedPlayer(pl, game));
                    }
                    const before = await repo.matches.crconPlayers(round.id) ?? [];
                    const after = recordCrconPlayers(before, players, step.elapsed, Math.floor(Date.parse(round.startedAt) / 1000), Math.floor(Date.now() / 1000));
                    if (JSON.stringify(after) !== JSON.stringify(before)) await repo.matches.saveCrconPlayers(round.id, after);
                    // The score charts' points, off the cache just recorded: one a minute, and one on
                    // the pass that sees the round end, so its charts close on the final totals.
                    if (pass.end || Date.now() - lastSeriesMs >= SCORE_SERIES_MS) {
                      lastSeriesMs = Date.now();
                      const points = scoreSeriesPoints(after, step.elapsed);
                      if (points.length) await repo.matches.appendScoreSeries(round.id, points);
                    }
                  }
                } catch (err) {
                  slog.debug("player recording pass skipped", { err });
                }
              }
            }
          } catch (err) {
            slog.debug("score timeline pass skipped", { err });
          }
        }
        if (Date.now() - lastSnapshotMs >= ROSTER_SNAPSHOT_MS) {
          lastSnapshotMs = Date.now();
          // The previous observation rides along: it is the latest moment a session the roster no
          // longer backs can honestly be said to have lasted until (see session-reap.ts).
          lastObservedAt = await snapshotRoster(repo, server, client, slog, lastObservedAt);
        }
        // The live match board rides this loop's connection rather than opening its own — it wants
        // exactly the reads already happening here. The floor is checked out here so a disabled
        // board costs nothing; the configured interval is the board's own business.
        if (Date.now() - lastBoardMs >= DISCORD_STATUS_BOARD_MIN_SEC * 1000) {
          if (await drawStatusBoard(repo, server, client, slog, Date.now() - lastBoardMs)) lastBoardMs = Date.now();
        }
        // The rest of the poll, with the score checked every 2 seconds in it, as CRCON's loop
        // checks it (score-check.ts): a cap flip is stamped within 2 seconds of the change. The
        // running round's timeline only, and never while a restore holds the writers off.
        const recordsRounds = server.game === "hll" || server.game === "hllv";
        await waitCheckingScore({
          untilMs: Date.now() + POLL_MS, stepMs: SCORE_CHECK_MS,
          now: Date.now, sleep: (ms) => ctl.sleep(ms), stopped: () => ctl.stopped,
          check: async () => {
            if (!recordsRounds || restoreInProgress()) return;
            try {
              timelineElapsed = await scoreCheck({
                newestRound: async () => (await repo.matches.list(server.id, 1, 0))[0] ?? null,
                readSession: async () => normalizeSession(await client.readState("session")),
                recordTimeline: (roundId, step) => repo.matches.recordTimeline(roundId, step),
                now: Date.now,
              }, server.game, timelineElapsed);
            } catch (err) {
              slog.debug("score check skipped", { err });
            }
          },
        });
      }
    } catch (err) {
      slog.error("connection error, will reconnect", { err, reconnectMs: RECONNECT_MS });
      // The outage clock is measured from the last GOOD read, so one alert fires once the server
      // has been unreachable past the threshold — not on the first blip.
      const r = onPollFail(health, Date.now(), SERVER_DARK_MS); health = r.state;
      if (r.emit) { emitHealth(r.emit); slog.warn("server has gone dark", { downMinutes: r.emit.downMinutes }); }
    } finally {
      await client.disconnect().catch(() => {});
    }
    if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
  }
}

/**
 * Ban reconciliation sweep: every active server's ban list, compared against the decisions table.
 *
 * `planBanReconcile` decides; this only does the I/O. Findings repeat every tick as long as the
 * situation stands, so the audit report is throttled by plan signature — a standing dry-run
 * finding is one trail entry, not one per five minutes. Applied changes are audited per action,
 * because each one is an event, not a state.
 *
 * Report-only unless the server's own "fix what it finds" switch is on (automation
 * `banSyncApply`, default off; read every sweep). This is the one loop in the app that issues
 * bans on its own, and the dangerous version of it is one meeting a state table it doesn't agree
 * with — so it reports what it WOULD do, and starts doing it only where staff switched the fix on
 * after reading a few of those reports.
 *
 * Writes the game accepts and never carries out are re-sent RECONCILE_MAX_SENDS times, then left
 * alone and reported once (see StuckWrites) — never re-sent, and re-audited as a fresh ban, every
 * sweep forever.
 *
 * @returns the servers it fixed on this sweep (rather than only reported), for the heartbeat.
 */
async function banReconcileSweep(repo: Repository, lastSig: Map<string, string>, stuck: { apply: StuckWrites; lift: StuckWrites }): Promise<string[]> {
  const [servers, decisions] = await Promise.all([repo.servers.list(), repo.playerBans.list()]);
  const nowIso = new Date().toISOString();
  const fixing: string[] = [];
  for (const server of servers) {
    // Observe servers and servers with this sweep switched off are skipped entirely (see
    // reconcileMode); the rest are reported on, and fixed only where the server's fix is on.
    const mode = reconcileMode(server, "ban");
    if (mode === "skip") continue;
    const fix = mode === "fix";
    if (fix) fixing.push(server.name);
    const slog = log.child({ serverId: server.id, server: server.name });
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const [temp, perma] = await Promise.all([client.execute("getTempBans"), client.execute("getPermaBans")]);
      // With the game's own placement time and duration: a temp ban it still lists after its time
      // ran out is one it refuses to remove, and the planner leaves it alone (gameBanRanOut).
      const gameBans: GameBanLite[] = [
        ...normalizeGameBans(temp, "temp").map((b) => ({ playerId: b.playerId, type: "temp" as const, ts: b.ts, durationHours: b.durationHours })),
        ...normalizeGameBans(perma, "perma").map((b) => ({ playerId: b.playerId, type: "perma" as const })),
      ].filter((b) => b.playerId);
      const plan = planBanReconcile(server.id, server.game, decisions, gameBans, nowIso);

      const sig = reconcileSignature(plan);
      const empty = !plan.apply.length && !plan.lift.length && !plan.foreign.length;
      if (empty) { lastSig.delete(server.id); stuck.apply.clear(server.id); stuck.lift.clear(server.id); continue; }

      if (!fix) {
        // Switching the fix back on starts its tries over.
        stuck.apply.clear(server.id); stuck.lift.clear(server.id);
        // Dry-run: one report per STANDING situation, not per tick.
        if (lastSig.get(server.id) === sig) continue;
        lastSig.set(server.id, sig);
        await repo.audit.create({
          actorUserId: null, actorName: "ban-sync", action: "bans.reconcile",
          targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
          summary: `[dry-run] ${server.name}: would apply ${plan.apply.length} ban(s), lift ${plan.lift.length}, and found ${plan.foreign.length} placed outside the panel. Apply from the Bans page (Sync with game), or switch on "Fix what it finds" under this server's Ban reconciliation (Administration → Connections → Automation).`,
          data: {
            dryRun: true,
            apply: plan.apply.map((d) => ({ playerId: d.playerId, playerName: d.playerName, kind: d.kind })),
            lift: plan.lift, foreign: plan.foreign,
          },
        });
        slog.info("ban reconcile (dry-run)", { apply: plan.apply.length, lift: plan.lift.length, foreign: plan.foreign.length });
        continue;
      }

      const banKey = (b: { playerId: string; kind: string }) => `${b.playerId}:${b.kind}`;
      const applying = stuck.apply.plan(server.id, plan.apply, banKey);
      const lifting = stuck.lift.plan(server.id, plan.lift, banKey);
      // The stored reason is what staff TYPED — placeholders and all. Filled here, for this player on
      // THIS server, so a ban carried to another server never shows the player raw braces.
      const banRenderer = applying.send.length ? rendererFor(repo, server, client) : null;
      for (const d of applying.send) {
        try {
          const reason = await banRenderer!.render(d.reason, { playerId: d.playerId, playerName: d.playerName });
          if (d.kind === "perma") {
            await client.execute("permaBanPlayer", { playerId: d.playerId, reason, adminName: "ban-sync" });
          } else {
            // Hours from the decision's remaining time — the game takes a duration, the record
            // keeps a date. Guarded >0 above by the planner's active check.
            const hours = d.expiresAt ? Math.max(1, Math.ceil((Date.parse(d.expiresAt) - Date.now()) / 3_600_000)) : 1;
            await client.execute("tempBanPlayer", { playerId: d.playerId, reason, hours, adminName: "ban-sync" });
          }
          stuck.apply.accepted(server.id, banKey(d));
          await repo.audit.create({
            actorUserId: null, actorName: "ban-sync", action: `player.${d.kind === "perma" ? "permaban" : "tempban"}`,
            targetType: "player", targetId: d.playerId, targetName: d.playerName ?? undefined, serverId: server.id,
            summary: `applied the standing ${d.kind} ban on ${d.playerName || d.playerId} to ${server.name} — ${d.reason}`,
            data: { playerId: d.playerId, reason: d.reason, reconcile: true, banId: d.id },
          });
          slog.info("applied standing ban", { playerId: d.playerId, kind: d.kind });
        } catch (err) {
          slog.warn("could not apply standing ban — will retry next sweep", { playerId: d.playerId, err: (err as Error).message });
        }
      }
      for (const l of lifting.send) {
        try {
          await client.execute(l.kind === "perma" ? "removePermaBan" : "removeTempBan", { playerId: l.playerId });
          stuck.lift.accepted(server.id, banKey(l));
          await repo.audit.create({
            actorUserId: null, actorName: "ban-sync", action: `player.${l.kind === "perma" ? "unban_perma" : "unban_temp"}`,
            targetType: "player", targetId: l.playerId, serverId: server.id,
            summary: `lifted a ${l.kind} ban on ${server.name} whose decision was unbanned or expired`,
            data: { playerId: l.playerId, reconcile: true },
          });
          slog.info("lifted stale game ban", { playerId: l.playerId, kind: l.kind });
        } catch (err) {
          slog.warn("could not lift stale ban — will retry next sweep", { playerId: l.playerId, err: (err as Error).message });
        }
      }
      if (applying.unreported.length || lifting.unreported.length) {
        const parts = [
          ...(applying.unreported.length ? [`${applying.unreported.length} ban(s) it applied are still not enforced (${namesOf(applying.unreported)})`] : []),
          ...(lifting.unreported.length ? [`${lifting.unreported.length} ban(s) it lifted are still enforced (${namesOf(lifting.unreported)})`] : []),
        ];
        await repo.audit.create({
          actorUserId: null, actorName: "ban-sync", action: "bans.reconcile",
          targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
          summary: `${server.name} keeps answering "done" without doing it: ${parts.join("; ")}. Sent ${RECONCILE_MAX_SENDS} times each, so the reconciler has stopped re-sending them. The usual cause is a player id this server cannot act on — Sync with game on the Bans page shows the counts before and after.`,
          data: {
            stuck: {
              apply: applying.unreported.map((d) => ({ playerId: d.playerId, playerName: d.playerName, kind: d.kind })),
              lift: lifting.unreported,
            },
          },
        });
        slog.warn("ban reconcile: writes the game accepts but does not carry out — stopped re-sending", { apply: applying.unreported.length, lift: lifting.unreported.length });
      }
      // Foreign bans are reported, never touched — throttled by the foreign part of the signature.
      if (plan.foreign.length) {
        const fsig = `foreign:${sig.split(" / ")[2]}`;
        if (lastSig.get(server.id) !== fsig) {
          lastSig.set(server.id, fsig);
          await repo.audit.create({
            actorUserId: null, actorName: "ban-sync", action: "bans.reconcile",
            targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
            summary: `${server.name} holds ${plan.foreign.length} ban(s) with no decision behind them — placed outside the panel. Run "Sync from servers" on the Bans page to adopt them.`,
            data: { foreign: plan.foreign },
          });
        }
      } else {
        lastSig.delete(server.id);
      }
    } catch (err) {
      slog.warn("ban reconcile: could not read server", { err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
  return fixing;
}

/**
 * VIP reconciliation sweep: every active server's live VIP list, compared against the grants table.
 *
 * `planVipReconcile` decides; this only does the I/O. The one call this loop makes that the ban
 * sweep has no analogue for: a server whose VIP list CANNOT be read (legacy text answers raw
 * strings; `normalizeGameVips` → null) is skipped with a log line, never planned against —
 * "couldn't check" and "the list is empty" are different facts, and only the second is the
 * wiped-list incident this sweep exists to catch.
 *
 * Same arming rule as the ban sweep, switched separately (automation `vipSyncApply`, default
 * off): applying its plan grants and revokes a paid perk, so it reports until staff switch its
 * fix on for that server. (The manual per-server sync on the VIPs page is staff-driven and does
 * not need the switch — a human is reading the plan.) Writes the game accepts and never carries
 * out stop after RECONCILE_MAX_SENDS sends, like the ban sweep's.
 *
 * @returns the servers it fixed on this sweep (rather than only reported), for the heartbeat.
 */
async function vipReconcileSweep(repo: Repository, lastSig: Map<string, string>, stuck: { apply: StuckWrites; remove: StuckWrites }): Promise<string[]> {
  const servers = await repo.servers.list();
  const nowIso = new Date().toISOString();
  const fixing: string[] = [];
  for (const server of servers) {
    const mode = reconcileMode(server, "vip"); // observe, or the sweep switched off: skipped entirely
    if (mode === "skip") continue;
    const fix = mode === "fix";
    if (fix) fixing.push(server.name);
    const slog = log.child({ serverId: server.id, server: server.name });
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const gameVips = normalizeGameVips(await client.execute("getVipIds"));
      if (gameVips === null) { slog.info("vip reconcile: this protocol/build does not answer a structured VIP list — skipped"); continue; }
      const grants = await repo.vips.list(server.id);
      const plan = planVipReconcile(grants, gameVips, nowIso);

      const sig = vipReconcileSignature(plan);
      const empty = !plan.apply.length && !plan.remove.length && !plan.foreign.length;
      if (empty) { lastSig.delete(server.id); stuck.apply.clear(server.id); stuck.remove.clear(server.id); continue; }

      if (!fix) {
        // Switching the fix back on starts its tries over.
        stuck.apply.clear(server.id); stuck.remove.clear(server.id);
        // Dry-run: one report per STANDING situation, not per tick.
        if (lastSig.get(server.id) === sig) continue;
        lastSig.set(server.id, sig);
        await repo.audit.create({
          actorUserId: null, actorName: "vip-sync", action: "vips.reconcile",
          targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
          summary: `[dry-run] ${server.name}: the game lists ${gameVips.length} VIP(s) — would restore ${plan.apply.length} missing grant(s), remove ${plan.remove.length} (expired/paused), and found ${plan.foreign.length} granted outside the panel. Apply from the VIPs page (Sync with game), or switch on "Fix what it finds" under this server's VIP reconciliation (Administration → Connections → Automation).`,
          data: {
            dryRun: true,
            apply: plan.apply.map((v) => ({ playerId: v.playerId, playerName: v.playerName, expiration: v.expiration })),
            remove: plan.remove, foreign: plan.foreign,
          },
        });
        slog.info("vip reconcile (dry-run)", { onGame: gameVips.length, apply: plan.apply.length, remove: plan.remove.length, foreign: plan.foreign.length });
        continue;
      }

      const byPlayer = (v: { playerId: string }) => v.playerId;
      const restoring = stuck.apply.plan(server.id, plan.apply, byPlayer);
      const removing = stuck.remove.plan(server.id, plan.remove, byPlayer);
      for (const v of restoring.send) {
        try {
          await client.execute("addVip", { playerId: v.playerId, description: v.playerName || v.comment || "VIP" });
          stuck.apply.accepted(server.id, v.playerId);
          await repo.audit.create({
            actorUserId: null, actorName: "vip-sync", action: "vip.grant",
            targetType: "player", targetId: v.playerId, targetName: v.playerName ?? undefined, serverId: server.id,
            summary: `restored the VIP grant for ${v.playerName || v.playerId} on ${server.name} — the game was not listing it`,
            data: { playerId: v.playerId, expiration: v.expiration, reconcile: true },
          });
          slog.info("restored missing VIP", { playerId: v.playerId });
        } catch (err) {
          slog.warn("could not restore missing VIP — will retry next sweep", { playerId: v.playerId, err: (err as Error).message });
        }
      }
      for (const r of removing.send) {
        try {
          await client.execute("removeVip", { playerId: r.playerId });
          stuck.remove.accepted(server.id, r.playerId);
          await repo.audit.create({
            actorUserId: null, actorName: "vip-sync", action: "vip.revoke",
            targetType: "player", targetId: r.playerId, targetName: r.playerName ?? undefined, serverId: server.id,
            summary: `removed the game's VIP entry for ${r.playerName || r.playerId} on ${server.name} — the grant is ${r.why}`,
            data: { playerId: r.playerId, why: r.why, reconcile: true },
          });
          slog.info("removed stale game VIP", { playerId: r.playerId, why: r.why });
        } catch (err) {
          slog.warn("could not remove stale VIP — will retry next sweep", { playerId: r.playerId, err: (err as Error).message });
        }
      }
      if (restoring.unreported.length || removing.unreported.length) {
        const parts = [
          ...(restoring.unreported.length ? [`${restoring.unreported.length} VIP(s) it restored are still not listed (${namesOf(restoring.unreported)})`] : []),
          ...(removing.unreported.length ? [`${removing.unreported.length} VIP entr${removing.unreported.length === 1 ? "y" : "ies"} it removed ${removing.unreported.length === 1 ? "is" : "are"} still listed (${namesOf(removing.unreported)})`] : []),
        ];
        await repo.audit.create({
          actorUserId: null, actorName: "vip-sync", action: "vips.reconcile",
          targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
          summary: `${server.name} keeps answering "done" without doing it: ${parts.join("; ")}. Sent ${RECONCILE_MAX_SENDS} times each, so the reconciler has stopped re-sending them. The usual cause is a player id this server cannot act on — Sync with game on the VIPs page shows the counts before and after.`,
          data: {
            stuck: {
              apply: restoring.unreported.map((v) => ({ playerId: v.playerId, playerName: v.playerName, expiration: v.expiration })),
              remove: removing.unreported,
            },
          },
        });
        slog.warn("vip reconcile: writes the game accepts but does not carry out — stopped re-sending", { apply: restoring.unreported.length, remove: removing.unreported.length });
      }
      // Foreign entries are reported, never touched — throttled like the dry-run report.
      if (plan.foreign.length) {
        const fsig = `foreign:${sig.split(" / ")[2]}`;
        if (lastSig.get(server.id) !== fsig) {
          lastSig.set(server.id, fsig);
          await repo.audit.create({
            actorUserId: null, actorName: "vip-sync", action: "vips.reconcile",
            targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
            summary: `${server.name} lists ${plan.foreign.length} VIP(s) with no grant behind them — added outside the panel. Grant them on the VIPs page to adopt them, or remove them in game.`,
            data: { foreign: plan.foreign },
          });
        }
      } else {
        lastSig.delete(server.id);
      }
    } catch (err) {
      slog.warn("vip reconcile: could not read server", { err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
  return fixing;
}

/**
 * Watch expirations. A watch REASON can carry its own expiry; a lapsed reason stops counting the
 * moment its time passes (every reader filters on it), but the cached `player_flags.watchlist`
 * boolean — the 👁 on rosters, the Discord join alert — stays armed until something recomputes
 * it. This is that something: players whose last active reason has lapsed are disarmed, audited
 * under the sweep's own name so the trail says why the watch lifted with nobody at the keyboard.
 */
async function sweepLapsedWatches(repo: Repository): Promise<void> {
  const lapsed = await repo.watchReasons.lapsedWatchers().catch(() => [] as string[]);
  for (const playerId of lapsed) {
    try {
      await repo.playerFlags.set(playerId, { watchlist: false }, { userId: null, name: "watch-expiry" });
      const player = await repo.players.findById(playerId).catch(() => null);
      await repo.audit.create({
        actorUserId: null, actorName: "watch-expiry", action: "player.watchlist",
        targetType: "player", targetId: playerId, targetName: player?.name ?? null,
        summary: `watch on ${player?.name ?? playerId} expired — its last active reason lapsed`,
        data: { op: "expired" },
      });
    } catch (err) {
      log.warn("could not lift an expired watch — will retry next sweep", { playerId, err: (err as Error).message });
    }
  }
}

/**
 * Approval requests age out rather than linger: a card from days ago describes a server state
 * nobody remembers, and nothing that stale should ever auto-execute. Pending lines void, the
 * request closes as expired, and the trail says so under the sweep's own name — the requester
 * learns "nobody got to it" instead of staring at a silent pending state forever.
 */
async function sweepExpiredRequests(repo: Repository): Promise<void> {
  const expired = await repo.approvals.expireDue(new Date().toISOString()).catch(() => []);
  const token = process.env.DISCORD_TOKEN;
  for (const r of expired) {
    const voided = r.lines.filter((l) => l.state === "voided").length;
    await repo.audit.create({
      actorUserId: null, actorName: "request-expiry", action: "request.expire",
      targetType: "request", targetId: r.id,
      summary: `approval request by ${r.requesterName} expired unanswered (${voided} line(s) never decided)`,
      data: { requestId: r.id, requestedBy: r.requesterName, requestedByUserId: r.requesterUserId },
    }).catch(() => {});
    /*
     * ...and its Discord card closes with it. A closed card keeps the story and loses the levers —
     * that is true of every decision the panel or the relay makes, and was not true of expiry: the
     * card sat there with ✋ and working buttons on a request that had been dead for days, and
     * pressing Approve answered "That request is already expired."
     *
     * The API stores the card's rendered text beside its message id (approval-cards.ts) precisely
     * so this can happen here, where nothing knows how a request is worded.
     */
    if (!token) continue;
    const ref = (await repo.pluginKv.get(APPROVALS_RELAY_KV_NS, r.id).catch(() => null)) as
      { channelId?: string; messageId?: string; content?: string } | null;
    if (!ref?.channelId || !ref.messageId || !ref.content) continue;
    // Trimmed to fit if it must: an edit past Discord's limit is refused, and the card would keep
    // its working buttons on a request that is gone.
    const closed = closedApprovalCard(ref.content, voided);
    const out = await editText(token, ref.channelId, ref.messageId, closed);
    if (out === "ok") await repo.pluginKv.set(APPROVALS_RELAY_KV_NS, r.id, { ...ref, content: closed }).catch(() => {});
    else if (out === "gone") await repo.pluginKv.remove(APPROVALS_RELAY_KV_NS, r.id).catch(() => {});
  }
  // Abandoned CARTS go too: an unsubmitted draft nobody has touched for the admin-set window is
  // scratch, not record — nothing in it ever executed or was filed, so it deletes without an
  // audit row (a log line names whose carts were tidied). 0 = keep forever.
  const ttlHours = (await repo.appConfig.get().catch(() => null))?.requestDraftTtlHours ?? 0;
  if (ttlHours > 0) {
    const stale = await repo.approvals.discardStaleDrafts(new Date(Date.now() - ttlHours * 3_600_000).toISOString()).catch(() => []);
    if (stale.length) log.info(`discarded ${stale.length} stale request draft(s): ${stale.map((d) => `${d.requesterName} (${d.lines.length} lines)`).join(", ")}`);
  }
}

/**
 * Sweep expired VIPs: the game's native VIP has no expiry, so we own it. Any grant whose stored
 * expiration has passed is removed from the game (native RemoveVip) and from our table. Grouped by
 * server so we open one connection each. Observe servers can't write, so their expired grants are
 * left in place (the guard would refuse RemoveVip) — VIP is only ever granted on active servers.
 *
 * Which rows, which servers, and when a refusal from the game may be ignored are all decided by
 * `readVipExpiryPlan` (retired servers included, and left alone); this is the I/O around it.
 */
async function sweepExpiredVips(repo: Repository): Promise<void> {
  const read = await readVipExpiryPlan(repo, new Date().toISOString());
  if (!read) return;
  const { plan, serverById: byId } = read;

  for (const v of plan.orphans) await repo.vips.remove(v.serverId, v.playerId);

  for (const { serverId, rows } of plan.work) {
    const server = byId.get(serverId)!;
    const slog = log.child({ serverId, server: server.name });
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      for (const { row: v, gameMayStillHoldIt } of rows) {
        let refusal: string | null = null;
        try {
          await client.execute("removeVip", { playerId: v.playerId });
        } catch (err) {
          refusal = (err as Error).message;
        }
        // A refusal only blocks the row when the game might really still be holding the VIP. A
        // paused grant was taken off the game when it was paused, so "no such VIP" is the right
        // answer — and letting it block the row is what kept a grant that expired mid-pause in the
        // table for good, retried and warned about every five minutes.
        if (refusal && gameMayStillHoldIt) {
          slog.warn("could not remove expired VIP", { playerId: v.playerId, err: refusal });
          continue;
        }
        // The row goes only while it is still expired and no group perk holds it. One extended,
        // or taken into a perk's hold, since the read stays — and gets back the game entry just
        // removed from under it.
        if (!(await repo.vips.removeExpired(serverId, v.playerId))) {
          const now = await repo.vips.get(serverId, v.playerId).catch(() => null);
          if (now && !(now.pausedUntil && Date.parse(now.pausedUntil) > Date.now())) {
            await client.execute("addVip", { playerId: v.playerId, description: now.playerName || v.playerName || "VIP" })
              .catch((err) => slog.warn("could not put back a VIP that changed while it was being expired", { playerId: v.playerId, err: (err as Error).message }));
          }
          continue;
        }
        await repo.audit.create({
          actorUserId: null, actorName: "system", action: "vip.expire",
          targetType: "player", targetId: v.playerId, targetName: v.playerName ?? undefined, serverId,
          summary: `VIP expired for ${v.playerName || v.playerId} on ${server.name}${refusal ? " (it was paused, so the game already had none)" : ""}`,
          data: { playerId: v.playerId, expiration: v.expiration, ...(refusal ? { pausedAtExpiry: true } : {}) },
        });
        slog.info("removed expired VIP", { playerId: v.playerId, wasPaused: Boolean(v.pausedUntil) });
      }
    } catch (err) {
      slog.warn("VIP sweep: could not connect", { err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

/** A perk start whose outcome the store could not tell back — see settleUnreadStarts. */
interface UnreadStart { serverId: string; playerId: string; playerName: string | null; groups: VipGroupHoldSource[]; fresh: boolean; addToGame: boolean }
const unreadStarts = new Map<string, UnreadStart>();

/** The start of a hold, on the player's VIP history. */
async function auditHoldStart(repo: Repository, server: ServerRow, st: { playerId: string; playerName: string | null; groups: VipGroupHoldSource[]; addToGame: boolean }, row: VipRow): Promise<void> {
  const banked = row.groupHold!.bankedMs;
  await repo.audit.create({
    actorUserId: null, actorName: "group perks", action: "vip.group_hold",
    targetType: "player", targetId: st.playerId, targetName: st.playerName ?? undefined, serverId: server.id,
    summary: `${st.playerName || st.playerId} holds permanent VIP on ${server.name} while in ${st.groups.map((g) => g.name).join(", ")}${banked > 0 ? ` — ${describeSpan(banked)} of timed VIP frozen until they leave` : ""}`,
    data: { playerId: st.playerId, bankedMs: banked, groupIds: st.groups.map((g) => g.id), ...(st.addToGame ? {} : { pausedOffGame: true }) },
  }).catch(() => {});
}

/**
 * Take a game VIP entry a start added back off — only while no grant stands behind it, and back on
 * if one was written while it came off (the expiry sweep's put-back). A store that cannot be read
 * is not "no grant": nothing is removed then, and the caller settles it later ("unsettled"), as it
 * does a removal the game refused.
 */
async function takeBackStartEntry(repo: Repository, client: ReturnType<typeof gameClientFor>, sid: string, playerId: string, playerName: string | null): Promise<"settled" | "unsettled"> {
  const standing = await repo.vips.get(sid, playerId).catch(() => undefined);
  if (standing === undefined) return "unsettled";
  if (standing) return "settled";
  try { await client.execute("removeVip", { playerId }); } catch (err) {
    log.warn("group perks: a VIP added for a hold that did not start could not be taken back off the game", { serverId: sid, playerId, err: (err as Error).message });
    return "unsettled";
  }
  const since = await repo.vips.get(sid, playerId).catch(() => null);
  if (since && !(since.pausedUntil && Date.parse(since.pausedUntil) > Date.now())) {
    await client.execute("addVip", { playerId, description: since.playerName || playerName || "VIP" })
      .catch((err) => log.warn("group perks: could not put back a VIP granted while a start was undone", { serverId: sid, playerId, err: (err as Error).message }));
  }
  return "settled";
}

/**
 * Starts whose outcome went unread, settled at the top of the next round — before anything is
 * planned, since a game entry with no grant behind it would read as the player's own VIP and never
 * be managed. A hold that did land is recorded; a game entry only the start added, with no grant
 * behind it, comes off; anything else is left as it is. One the store still cannot answer waits
 * another round. (Kept in memory: a worker restart in between leaves such an entry to the VIP
 * reconcile.)
 */
async function settleUnreadStarts(repo: Repository): Promise<void> {
  const servers = new Map((await repo.servers.list()).map((s) => [s.id, s]));
  for (const [key, st] of [...unreadStarts]) {
    const server = servers.get(st.serverId);
    if (!server) { unreadStarts.delete(key); continue; }
    let row: VipRow | null;
    try { row = await repo.vips.get(st.serverId, st.playerId); } catch { continue; }
    if (row?.groupHold) { unreadStarts.delete(key); await auditHoldStart(repo, server, st, row); continue; }
    if (row || !st.fresh || !st.addToGame) { unreadStarts.delete(key); continue; }
    // A server that no longer takes writes (observe mode, or its VIP sweep switched off) is not
    // written to from here — nor retried every round: the entry is left for the VIP reconcile.
    if (!perkWritable(server)) {
      unreadStarts.delete(key);
      log.warn("group perks: a start's game entry was not settled — the server no longer takes writes; left for the VIP reconcile", { serverId: st.serverId, playerId: st.playerId });
      continue;
    }
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      if ((await takeBackStartEntry(repo, client, st.serverId, st.playerId, st.playerName)) === "settled") unreadStarts.delete(key);
    } catch (err) {
      log.warn("group perks: could not reach a server to settle a start — tried again next round", { serverId: st.serverId, playerId: st.playerId, err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

/**
 * Group VIP perks: hold, refresh and release, from membership. The decisions are planPerkHolds's
 * (group-perks.ts, which says what this will and will not do); this is the I/O around it.
 *
 * Everything that could not be read aborts the round before anything is written — a membership
 * list that failed to load must never read as "everyone left" — except a game's VIP list, whose
 * failure holds back only the starts that needed it. Releases and refreshes are database writes:
 * a released grant becomes dated and the expiry sweep takes it off the game when that date comes
 * (straight away, when nothing was banked and no severance is due). Returns what each group could
 * not do this round, for the Groups page.
 */
async function reconcileGroupPerks(repo: Repository): Promise<Record<string, PerkNotes>> {
  if (unreadStarts.size) await settleUnreadStarts(repo);
  const groups = (await repo.playerGroups.list()).filter((g) => g.vipPerk);
  const held = await repo.vips.groupHeld();
  if (!groups.length && !held.length) return {};
  const servers = await repo.servers.list();
  const perkGroups: PerkGroup[] = [];
  for (const g of groups) {
    const members = await repo.playerGroups.members(g.id);
    perkGroups.push({ id: g.id, name: g.name, perk: g.vipPerk!, members: members.map((m) => ({ playerId: m.playerId, playerName: m.playerName })) });
  }
  const ids = [...new Set(perkGroups.flatMap((g) => g.members.map((m) => m.playerId)))];
  const known = ids.length ? await repo.players.findByPlatformIds(ids) : [];
  const gameOf = new Map(known.map((p) => [p.platformId, p.game]));
  const { desired, notes } = desiredHolds(perkGroups, servers, gameOf);

  const rows = new Map<string, VipRow>();
  const inPlay = new Set([...[...desired.values()].map((d) => d.serverId), ...held.map((h) => h.serverId)]);
  for (const sid of inPlay) for (const v of await repo.vips.list(sid)) rows.set(`${v.serverId}|${v.playerId}`, v);
  const byId = new Map(servers.map((s) => [s.id, s]));

  // A first look to learn which servers' own VIP lists the starts need (players with no grant row).
  const scratch = new Map([...notes].map(([k, v]) => [k, { ...v }]));
  const first = planPerkHolds({ desired, rows, servers, gameLists: new Map(), nowMs: Date.now(), notes: scratch });
  const clients = new Map<string, ReturnType<typeof gameClientFor>>();
  const gameLists = new Map<string, Set<string> | null>();
  try {
    for (const sid of first.needLists) {
      const server = byId.get(sid);
      if (!server) continue;
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        clients.set(sid, client);
        const listed = normalizeGameVips(await client.execute("getVipIds"));
        gameLists.set(sid, listed ? new Set(listed.map((x) => x.playerId)) : null);
      } catch (err) {
        gameLists.set(sid, null);
        log.warn("group perks: could not read a server's VIP list — its new holds wait a round", { serverId: sid, err: (err as Error).message });
        await client.disconnect().catch(() => {});
        clients.delete(sid);
      }
    }
    const nowMs = Date.now();
    const perkSeverances = new Map(perkGroups.map((g) => [g.id, g.perk.severanceMinutes || 0]));
    const plan = planPerkHolds({ desired, rows, servers, gameLists, nowMs, notes, perkSeverances });

    // Only while the hold still remembers what this round read: a severance a person set meanwhile
    // (the perk switched off without it, say) is never overwritten by this older plan.
    for (const r of plan.refresh) await repo.vips.setGroupHoldSources(r.serverId, r.playerId, r.groups, r.was);

    for (const r of plan.release) {
      // Only if nothing moved since the read: time banked or a severance zeroed meanwhile waits
      // for next round's plan, which sees it.
      const row = await repo.vips.endGroupHold(r.serverId, r.playerId, r.expiration, { bankedMs: r.bankedMs, severanceMinutes: r.recordedSeverance });
      if (!row) continue;
      const server = byId.get(r.serverId);
      const who = r.playerName || r.playerId;
      const giving = r.bankedMs + r.severanceMinutes * 60_000;
      await repo.audit.create({
        actorUserId: null, actorName: "group perks", action: "vip.group_release",
        targetType: "player", targetId: r.playerId, targetName: r.playerName ?? undefined, serverId: r.serverId,
        summary: giving > 0
          ? `${who} is no longer held by ${r.groups.map((g) => g.name).join(", ") || "a group"} on ${server?.name ?? "a server"}: permanent VIP ends — ${r.bankedMs > 0 ? `${describeSpan(r.bankedMs)} of frozen VIP given back` : "nothing was frozen"}${r.severanceMinutes > 0 ? ` + ${describeSpan(r.severanceMinutes * 60_000)} severance` : ""}, VIP until ${r.expiration}`
          : `${who} is no longer held by ${r.groups.map((g) => g.name).join(", ") || "a group"} on ${server?.name ?? "a server"}: permanent VIP ends, with no frozen VIP or severance to give back — removed at the next VIP sweep`,
        data: { playerId: r.playerId, expiration: r.expiration, bankedMs: r.bankedMs, severanceMinutes: r.severanceMinutes, groupIds: r.groups.map((g) => g.id) },
      }).catch(() => {});
    }

    const startsByServer = new Map<string, typeof plan.start>();
    for (const st of plan.start) (startsByServer.get(st.serverId) ?? startsByServer.set(st.serverId, []).get(st.serverId)!).push(st);
    for (const [sid, starts] of startsByServer) {
      const server = byId.get(sid);
      if (!server) continue;
      let client = clients.get(sid);
      if (!client && starts.some((st) => st.addToGame)) {
        client = gameClientFor(server);
        try { await connectGameClient(client, server); clients.set(sid, client); } catch (err) {
          log.warn("group perks: could not reach a server — its new holds wait a round", { serverId: sid, err: (err as Error).message });
          await client.disconnect().catch(() => {});
          continue;
        }
      }
      for (const st of starts) {
        // Ran close to its end while the round read the game: the sweep's for now (see expiringSoon).
        if (st.expiration && expiringSoon({ expiration: st.expiration, pauseMode: null, pausedUntil: null }, Date.now())) continue;
        if (st.addToGame) {
          try { await client!.execute("addVip", { playerId: st.playerId, description: st.playerName || "VIP" }); } catch (err) {
            log.warn("group perks: the game refused a VIP — retried next round", { serverId: sid, playerId: st.playerId, err: (err as Error).message });
            continue;
          }
        }
        // The store answered neither the start nor the read after it: whether a hold stands is
        // settled next round, before anything is planned (see settleUnreadStarts).
        const unread = () => {
          unreadStarts.set(`${sid}|${st.playerId}`, { serverId: sid, playerId: st.playerId, playerName: st.playerName, groups: st.groups, fresh: st.fresh, addToGame: st.addToGame });
          log.warn("group perks: the store could not say whether a hold started — settled next round", { serverId: sid, playerId: st.playerId });
        };
        /*
         * A start that did not take leaves the game listing them with no record of why: next round
         * would read that as VIP of their own and never manage it. A game entry only this start
         * added (fresh: no grant stood at the round's read) comes back off while no grant stands
         * behind it (see takeBackStartEntry). The next round starts the hold from the perk as it
         * stands.
         */
        const undoFreshAdd = async () => {
          if (!st.addToGame || !st.fresh) return;
          if ((await takeBackStartEntry(repo, client!, sid, st.playerId, st.playerName)) === "unsettled") unread();
        };
        let row: VipRow | null;
        try {
          // whilePerks: a perk switched off (or its group deleted) since this round read it starts
          // nothing — the hold would record a severance the person ending it may have refused.
          row = await repo.vips.startGroupHold({ serverId: sid, playerId: st.playerId, playerName: st.playerName, groups: st.groups, createdByName: "group perks", whilePerks: true });
        } catch (err) {
          // The write may have landed with only its answer lost: a hold now standing is this one.
          const after = await repo.vips.get(sid, st.playerId).catch(() => undefined);
          if (after === undefined) { unread(); continue; }
          if (after?.groupHold) row = after;
          else {
            await undoFreshAdd();
            log.warn("group perks: a hold could not be recorded — retried next round", { serverId: sid, playerId: st.playerId, err: (err as Error).message });
            continue;
          }
        }
        if (!row?.groupHold) {
          // Refused: the perk changed since this round read it (whilePerks), or permanent VIP of
          // their own appeared meanwhile — whose game entry stays (it is their grant's now).
          await undoFreshAdd();
          continue;
        }
        await auditHoldStart(repo, server, st, row);
      }
    }
  } finally {
    for (const c of clients.values()) await c.disconnect().catch(() => {});
  }
  return Object.fromEntries(notes);
}

/**
 * Discord nudge for unread staff notices. Once a posted notice has been up for the configured
 * hours and someone STILL hasn't opened the announcements board, one reminder is posted in the
 * configured staff channel naming them (@mention when their Discord is linked). Exactly one nudge
 * per posting — nudged_at marks it done, and re-posting a notice clears it for a fresh cycle.
 */
async function nudgeUnreadAnnouncements(repo: Repository): Promise<void> {
  if (!discordToken()) return;
  const cfg = await repo.announcements.getNudgeConfig();
  if (!cfg.enabled || !cfg.channelId || !(cfg.afterHours > 0)) return;
  const posted = await repo.announcements.listPublished(100);
  const now = Date.now();
  const due = posted.filter((a) => !a.nudgedAt && a.publishedAt && now - Date.parse(a.publishedAt) >= cfg.afterHours * 3_600_000);
  if (!due.length) return;
  const users = await repo.users.list();
  for (const a of due) {
    const reads = await repo.announcements.reads(a.id);
    const readIds = new Set(reads.map((r) => r.userId));
    // Excused staff (away/on leave) are never NAMED — their receipts still record, and the audit
    // row below says who was left out, so an absent name is a written fact rather than a mystery.
    const { named: unread, excused } = splitUnread(users, readIds, cfg.excusedUserIds ?? []);
    if (unread.length) {
      const named = unread.map((u) => ({ discordId: u.discordId ?? null, name: u.discordNick || u.discordUsername || u.username }));
      const msg = buildNudgeMessage(a.title, a.publishedAt!, now, named);
      // The reminder IS its pings: the linked staff it names are let through, and nobody else.
      await postMessage(discordToken(), cfg.channelId, msg, nudgePings(named));
      await repo.audit.create({
        actorUserId: null, actorName: "system", action: "announcement.nudge",
        targetType: "announcement", targetId: a.id, targetName: a.title,
        summary: `nudged ${unread.length} staff who haven't read "${a.title}" (up ${cfg.afterHours}h+)${excused.length ? ` — ${excused.length} excused as away` : ""}`,
        data: { unread: unread.map((u) => u.username), ...(excused.length ? { excused: excused.map((u) => u.username) } : {}) },
      });
      log.info("nudged unread announcement", { title: a.title, unread: unread.length, excused: excused.length });
    }
    // Everyone read it in time → nothing to send, but the cycle is still complete.
    await repo.announcements.markNudged(a.id);
  }
}

/**
 * The events list, posted to Discord by itself on the day and time staff chose.
 *
 * The decision (is it due, and for which local date) and the message are both @app/payout's, and
 * both are shared with the API's "Post now" button — one builder, so the automatic post and a
 * pressed one cannot drift apart. All this does is the I/O and the latch.
 *
 * The latch is written whatever happens, INCLUDING when there was nothing to announce: a quiet
 * week is still a week whose post has been dealt with, and re-deciding it every tick would mean
 * a channel full of "nothing on" the moment somebody schedules something at teatime.
 *
 * A Discord failure is the one case that does NOT latch — it throws past this line, `background`
 * logs it, and the next tick tries again. That is deliberate: a channel that was briefly
 * unreachable should still get today's post, and midnight ends the attempts on its own.
 */
async function postEventsList(repo: Repository): Promise<void> {
  if (!discordToken()) return;
  const cfg = await repo.payoutEvents.getPostConfig();
  const { timezone } = await repo.appConfig.get();
  const due = dueEventsPost(cfg, timezone || "UTC");
  if (!due) return;
  // Resolve first, so an event that has opened or closed is not announced as still to come.
  await sweepPayoutEvents(repo);
  const [events, servers] = await Promise.all([repo.payoutEvents.list({ limit: 200 }), repo.servers.list()]);
  const message = buildEventsPost(events, {
    days: cfg.daysAhead,
    serverNames: new Map(servers.map((s) => [s.id, s.name])),
    literal: discordLiteral,
  });
  if (message) {
    // Already sized to Discord's budget by buildEventsPost (whole entries, never a sheared token).
    await postMessage(discordToken(), cfg.channelId, message);
    await repo.audit.create({
      actorUserId: null, actorName: "system", action: "economy.payoutEvent.post",
      targetType: "discord-channel", targetId: cfg.channelId, targetName: `channel ${cfg.channelId}`,
      summary: `posted the next ${cfg.daysAhead} day${cfg.daysAhead === 1 ? "" : "s"} of events to channel ${cfg.channelId}`,
      data: { channelId: cfg.channelId, days: cfg.daysAhead, manual: false },
    }).catch(() => {});
    log.info("events posted to Discord", { channelId: cfg.channelId, days: cfg.daysAhead });
  }
  await repo.payoutEvents.setPostConfig({ lastPostedOn: due.postFor });
}

/**
 * Seeding automod + seed-reward runner. One persistent connection per server on a slow poll
 * (SEED_POLL_MS) — quickened to SEED_FAST_POLL_MS while the server is seeding with a chase rule
 * armed (cap fight, containment), where thirty seconds is long enough to lose the objective the
 * rule exists to protect. Each tick reads the live roster, feeds it through the PURE `planSeedingTick`
 * (all the decision logic lives there, unit-tested without a server), then performs the I/O the
 * plan describes: accrue seed presence, announce, enforce disallowed roles (warn→punish→kick),
 * and — the instant the server crosses seeding→live — grant VIP to everyone who seeded long enough.
 *
 * Enforcement + rewards are suppressed (audited as "would…") when the config is in dry-run OR the
 * server is not in active engagement mode — the same rule the enforcer uses. All escalation memory
 * (warn/punish ladders, the previous phase) is per-connection in-process state, so it resets
 * cleanly on reconnect, exactly like the ingest `seen` set. Who to tell the rules is read from the
 * game log's joins instead, so a reconnect tells nobody twice.
 */
async function seedingServer(repo: Repository, bus: EventBus, server: ServerRow, ctl: RunnerControl): Promise<void> {
  if (!automationEnabled(server.automation, "seeding")) return parkDisabled(ctl);
  const mod = getGame(server.game);
  const roleName = (r: number) => mod?.descriptor.roles?.[r] ?? `role ${r}`;
  // For the announcement's restriction list: the class LABEL players read, not the stored id.
  const weaponClassName = (id: string) => mod?.descriptor.weaponClasses?.find((c) => c.id === id)?.label ?? id;
  const weaponClassOf = (w: string) => (mod ? classifyWeapon(mod.descriptor, w).id : null);
  // Per-connection memory carried across ticks (reset on reconnect).
  let escalation: EscalationState = new Map();
  let weaponEscalation: EscalationState = new Map();
  let capEscalation: EscalationState = new Map();
  let capOffense = new Map<string, number>(); // last seen offense score, the cap-fight baseline
  let capPosState = new Map<string, number>(); // first-seen-past-the-line clocks (positional cap fight)
  let paceState = new Map<string, number>();   // first-seen-in-a-locked-band clocks (offensive pace)
  let paceEscalation: EscalationState = new Map();
  let axisCal: AxisCalState | null = null;      // the round's self-calibrating geometry
  // Team number → side as confident reads established it — see enforcementSides — forgotten on a
  // map change (forgetSidesOnNewMap): last match's mapping is not this match's fact.
  const seedSideMemory = new Map<number, string | null>();
  const seedSideMap = { mapId: null as string | null };
  let lastGeometryNote: string | null = null;
  let lastCapFightState: string | null = null;
  let lastPaceNote: string | null = null;
  let lastStateSig = "";      // the last seeding_state row written, so an unchanged tick skips the write
  let lastStateWriteMs = 0;
  // Layout learning: the round whose vote has been recorded ("<layer>@<match start>"), and a
  // short-lived cache of each layer's learned layout so a tick does not re-query it.
  let layoutVotedFor: string | null = null;
  const layoutCache = new Map<string, { at: number; layout: LearnedLayout | null }>();
  let lastSessionRaw: { gameMode: string | null; mapId: string | null } | null = null;
  let containState = new Map<string, number>(); // first-seen-outside clocks for containment
  let containEscalation: EscalationState = new Map();
  // Join cursor for the seeding announcement: the rules are told to whoever joins while the server
  // seeds, once per join (CRCON's on_connected). It starts "now", so no backlog of earlier joins
  // is greeted, and it is not reset on a reconnect: joins during the outage are still told, once.
  let lastConnectTs = new Date().toISOString();
  let prevPhase: Phase = "idle";
  // Whether the committed phase has been confirmed by the counts since the last reset: only a
  // change after that is news for staff (seedingNews, app.seeding.phase).
  let phaseSettled = false;
  let pendingPhase: Phase | null = null;
  let pendingSinceMs = 0;
  let lastTickMs = 0;
  // Kill cursor for the weapon rules — starts "now" so enabling them never punishes a backlog
  // of kills from before anyone asked (the same rule the automod loop's cursor follows).
  let lastKillTs = new Date().toISOString();

  while (!ctl.stopped) {
    const client = gameClientFor(server);
    const slog = log.child({ serverId: server.id, server: server.name });
    try {
      await connectGameClient(client, server);
      while (!ctl.stopped) {
        const config = await repo.seeding.getConfig(server.id);
        if (!config || !config.enabled) {
          // Disabled: idle the connection but stay connected so re-enabling takes effect promptly.
          prevPhase = "idle"; phaseSettled = false; pendingPhase = null; pendingSinceMs = 0; escalation = new Map(); weaponEscalation = new Map(); capEscalation = new Map(); capOffense = new Map(); capPosState = new Map(); paceState = new Map(); paceEscalation = new Map(); axisCal = null; containState = new Map(); containEscalation = new Map(); lastTickMs = 0; lastCapFightState = null; lastGeometryNote = null; lastPaceNote = null;
          lastKillTs = new Date().toISOString(); // don't punish a backlog when re-enabled
          lastConnectTs = new Date().toISOString(); // nor greet one
          await ctl.sleep(SEED_POLL_MS);
          continue;
        }

        const now = Date.now();
        const elapsedSec = lastTickMs === 0 ? 0 : Math.round((now - lastTickMs) / 1000);
        lastTickMs = now;

        // Read the live roster and normalize onto the planner's shape.
        const raw = await client.readState("players"); // throws if the connection died → reconnect
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as { players?: unknown[] })?.players) ? (raw as { players: unknown[] }).players : [];
        const rosterRaw = list as Record<string, unknown>[];
        // Tags only matter when immunity-by-tag is configured; skip the per-player lookups otherwise.
        const wantTags = config.immuneTags.length > 0;
        const ids = rosterRaw.map(rosterIdOf).filter(Boolean);
        // One query for the whole roster. This used to be two per player, so a full server cost
        // 200 round trips every tick against a ten-connection pool.
        const tagsByPlatformId = wantTags
          ? await repo.playerTags.labelsByPlatformIds(ids).catch(() => new Map<string, string[]>())
          : new Map<string, string[]>();

        // ---- session + sides, read only while a rule that needs them could act ----
        // Two rules want the session: the cap fight (mode + team scores) and containment (which
        // MAP the round is on, to pick the drawn zones). Both only act while seeding, so idle/live
        // ticks skip the read; a failed read normalizes to nulls and both rules stand down.
        const wantCapFight = config.capFightEnabled && prevPhase === "seeding";
        // The zones need the session even with nothing painted — the auto fence takes the round
        // geometry from it (sides + map + scores) wherever no paint covers the map.
        const wantContain = config.containEnabled && prevPhase === "seeding";
        // The pace rule is a ROUND rule — it watches offensive rounds through seeding AND live,
        // so it keeps the session read alive after the go-live line where the seeding rules stop.
        const wantPace = config.paceEnabled && (prevPhase === "seeding" || prevPhase === "live");
        // Learning runs while the zones learn or enforce (Learn only / On) and while steamroll
        // protection, which uses the layouts, is on — through seeding AND live rounds: a full
        // server calibrates fastest, and every round is a vote for its layer.
        const wantLearn = (config.containEnabled || config.layoutLearnEnabled || config.paceEnabled) && (prevPhase === "seeding" || prevPhase === "live");
        let session: { gameMode: string | null; alliedScore: number | null; axisScore: number | null; mapId: string | null } | null = null;
        // The auto fence and the positional cap fight both want the scores and mode too.
        let sideByTeam = new Map<number, string | null>();
        let containZone: ReturnType<typeof resolveContainZone> = null;
        let roundStartMs: number | null = null;
        let roundId: string | null = null; // the open match's start as stored — the round's identity
        let learnedLayout: LearnedLayout | null = null;
        let sessionLayerId = ""; // the round's real layer id ("" when the session named only the map)
        if (wantCapFight || wantContain || wantPace || wantLearn) {
          const s = normalizeSession(await client.readState("session").catch(() => null));
          session = { gameMode: s.gameMode ?? null, alliedScore: s.alliedScore ?? null, axisScore: s.axisScore ?? null, mapId: s.mapId ?? s.mapName ?? null };
          lastSessionRaw = { gameMode: s.gameMode ?? null, mapId: s.mapId ?? s.mapName ?? null };
          const layerId = String(s.mapId ?? "").trim().toLowerCase();
          sessionLayerId = layerId;
          if (layerId) {
            const hit = layoutCache.get(layerId);
            if (hit && now - hit.at < LAYOUT_CACHE_MS) learnedLayout = hit.layout;
            else {
              const row = await repo.mapLayouts.get(layerId).catch(() => null);
              learnedLayout = learnedLayoutOf(row);
              layoutCache.set(layerId, { at: now, layout: learnedLayout });
            }
          }
          // The LAYER's own paint wins over the family's: the layer fixes which end each side
          // attacks from, so a family-wide paint can only ever be right for some of its layers.
          if (wantContain) {
            containZone = resolveContainZone(config, layerZoneKey(s.mapId ?? null))
              ?? resolveContainZone(config, zoneKeyOf(s.mapId ?? s.mapName ?? null));
          }
          if (wantPace || wantLearn) {
            // The round clock's zero is when the ROUND opened, which the matches tracker already
            // records: the pace rule times its unlocks from it, the layout learner its opening ten
            // minutes. An unreadable round start holds both (no clock, no punishment, no vote).
            const openMatch = await repo.matches.getOpen(server.id).catch(() => null);
            const t = openMatch?.startedAt ? Date.parse(openMatch.startedAt) : NaN;
            roundStartMs = Number.isFinite(t) ? t : null;
            roundId = roundStartMs !== null ? openMatch!.startedAt : null;
          }
          // Faction per raw team number, decided the way every live consumer decides it — with the
          // session's headcounts as evidence, not the static descriptor guess alone.
          const teamCounts = new Map<number, number>();
          for (const pl of rosterRaw) {
            const t = Number(pl?.team);
            if (Number.isFinite(t)) teamCounts.set(t, (teamCounts.get(t) ?? 0) + 1);
          }
          const sides = mod?.descriptor.sides ?? [];
          forgetSidesOnNewMap(seedSideMemory, seedSideMap, session.mapId);
          sideByTeam = enforcementSides(resolveTeamSides(sides, teamCounts, s), teamSidesConfident(sides, teamCounts, s), seedSideMemory);
        }

        const roster: SeedRosterPlayer[] = rosterRaw.map((pl) => {
          const playerId = rosterIdOf(pl);
          // The offense bucket has been spelled `offense` verbatim in both games' scoreData —
          // but the wire has mangled a bucket's casing before (the combat bucket arrives as
          // `cOMBAT`), and a mangled "offense" would blind the cap fight with exactly the shape
          // ticket closed-4996 reported. Enforcement reads the key case-insensitively; null stays
          // "unreadable", never zero.
          const sd = (pl?.scoreData ?? {}) as Record<string, unknown>;
          const offKey = "offense" in sd ? "offense" : Object.keys(sd).find((k) => k.toLowerCase() === "offense");
          const offRaw = offKey !== undefined ? sd[offKey] : undefined;
          const offense = offRaw != null && Number.isFinite(Number(offRaw)) ? Number(offRaw) : null;
          const side = sideByTeam.get(Number(pl?.team)) ?? null;
          return {
            playerId, name: String(pl?.name ?? ""), level: Number(pl?.level ?? 0), role: Number(pl?.role ?? -1),
            tags: tagsByPlatformId.get(playerId) ?? [],
            side: side === "allies" || side === "axis" ? side : null,
            offense,
            pos: rosterPosOf(pl),
          };
        });

        const progressRows = await repo.seeding.listProgress(server.id);
        const progress = new Map(progressRows.map((r) => [r.playerId, r.seconds]));
        const prevState = await repo.seeding.getState(server.id);
        const lastRewardMs = prevState?.lastRewardAt ? Date.parse(prevState.lastRewardAt) : 0;

        // ---- fresh kills for the weapon rules (only read while they could matter) ----
        // The event store keys kills by our internal uuid; the roster and every RCON command speak
        // the game's platform id — the same two-id-spaces translation the automod loop documents.
        const weaponKills: { playerId: string; name: string; weapon: string }[] = [];
        const wantWeaponKills = prevPhase === "seeding"
          && ((config.disallowedWeaponClasses?.length ?? 0) > 0 || (config.disallowedWeapons?.length ?? 0) > 0
            || (config.disallowedWeaponNames?.length ?? 0) > 0 || (config.disallowedCommanderAbilities?.length ?? 0) > 0);
        if (wantWeaponKills) {
          // Asked as the question it is — kills since the cursor — rather than "the newest 500
          // rows of everything, filtered here". On a busy seed the old read shipped and parsed
          // 500 full event rows every tick to find the handful of fresh kills among them.
          const recent = await repo.events.query({ serverId: server.id, kinds: ["evt.kill", "evt.teamkill"], from: lastKillTs, limit: 500 }).catch(() => []);
          const fresh = recent.filter((e) => e.ts > lastKillTs && e.actorPlayerId && e.weapon);
          for (const e of fresh) if (e.ts > lastKillTs) lastKillTs = e.ts;
          const ids = [...new Set(fresh.map((e) => e.actorPlayerId!))];
          const rows = ids.length ? await repo.players.findByIds(ids).catch(() => []) : [];
          const platformByDbId = new Map(rows.map((pl) => [pl.id, pl.platformId]));
          for (const e of fresh) {
            const platformId = platformByDbId.get(e.actorPlayerId!) ?? "";
            if (platformId) weaponKills.push({ playerId: platformId, name: e.actorName ?? "", weapon: e.weapon! });
          }
        } else {
          // Nothing consumes kills this tick, so nothing may be consumed later either.
          lastKillTs = new Date().toISOString();
        }

        // ---- who joined since the last tick: the seeding announcement's audience ----
        // Read every tick, whatever the phase, so a join while the server is live or idle is passed
        // over then rather than greeted later; the planner tells only those who joined while it
        // seeds.
        const { joined, cursor: nextConnectTs } = await joinsSince(repo, server.id, lastConnectTs);
        lastConnectTs = nextConnectTs;

        const plan = planSeedingTick({ config, roster, progress, escalation, weaponEscalation, weaponKills, weaponClassOf, session, capOffense, capEscalation, capPosState, roundStartMs, paceState, paceEscalation, axisCal, learnedLayout, containZone, containState, containEscalation, prevPhase, pendingPhase, pendingSinceMs, joined, elapsedSec, nowMs: now, lastRewardMs, roleName, weaponClassName });
        // The round geometry teaching itself is worth one line per change of mind — it is the
        // whole answer to "position rules need 50 maps painted", so its state must be checkable.
        if (plan.geometryNote && plan.geometryNote !== lastGeometryNote) {
          slog.info(`seeding geometry: ${plan.geometryNote}`, { mapId: lastSessionRaw?.mapId ?? null });
          lastGeometryNote = plan.geometryNote;
        }
        // Say when the cap-fight rule's CONDITION changes — above all when it is not enforcing.
        // Ticket closed-4996: punish-first was on, a seeder capped the 4th point, and the rule
        // said nothing. Keyed on the classified state (not the detail line) so a score changing
        // does not spam a log line, while any transition into a held or blind state does speak.
        if (plan.capFightState && plan.capFightState !== lastCapFightState) {
          const detail = { note: plan.capFightNote, gameMode: lastSessionRaw?.gameMode ?? null, mapId: lastSessionRaw?.mapId ?? null };
          const bad = plan.capFightState === "armed-blind" || plan.capFightState.startsWith("holding");
          if (bad) slog.warn(`seeding cap fight: ${plan.capFightNote ?? plan.capFightState}`, detail);
          else slog.info(`seeding cap fight: ${plan.capFightNote ?? plan.capFightState}`, detail);
          lastCapFightState = plan.capFightState;
        }
        // The pace rule reports the same way — a hold is a warn (it WANTS to act and cannot),
        // arming and standing down are info. Keyed on the note so a held state names its reason.
        if (plan.paceNote && plan.paceNote !== lastPaceNote) {
          const detail = { mapId: lastSessionRaw?.mapId ?? null };
          if (plan.paceNote.startsWith("holding")) slog.warn(`seeding pace: ${plan.paceNote}`, detail);
          else slog.info(`seeding pace: ${plan.paceNote}`, detail);
          lastPaceNote = plan.paceNote;
        }
        escalation = plan.escalation;
        weaponEscalation = plan.weaponEscalation;
        capEscalation = plan.capEscalation;
        capOffense = plan.capOffense;
        capPosState = plan.capPosState;
        paceState = plan.paceState;
        paceEscalation = plan.paceEscalation;
        axisCal = plan.axisCal;
        // One vote per round for this layer's layout, the first tick the round's trips agree —
        // and only under a real LAYER id: a session that reports just the map's display name
        // would file votes under a key no lookup or painter ever uses. The match's start is the
        // round's identity, so neither a later tick nor a restart mid-round votes a round twice.
        const voteLayer = sessionLayerId;
        const voteKey = voteLayer && roundId ? `${voteLayer}@${roundId}` : null;
        if (wantLearn && voteLayer && voteKey && plan.layoutSample && layoutVotedFor !== voteKey) {
          layoutVotedFor = voteKey;
          const vote = plan.layoutSample;
          await repo.mapLayouts.record(voteLayer, { axis: vote.axis, alliesDir: vote.alliesDir, round: roundId })
            .then((row) => {
              layoutCache.delete(voteLayer);
              if (row) slog.info("layout learned for this round", { mapId: voteLayer, axis: vote.axis, alliesDir: vote.alliesDir, travelers: vote.travelers });
            })
            .catch((e) => slog.warn("layout vote not recorded", { err: (e as Error).message }));
        }
        containState = plan.containState;
        containEscalation = plan.containEscalation;
        // A real change of phase, as staff would want it on a phone (seedingNews): not the
        // placeholder a reset starts from settling into the phase the server was already in.
        const news = seedingNews({ settled: phaseSettled, prevPhase }, plan);
        if (news.news) {
          bus.emit("app.seeding.phase", {
            kind: "app.seeding.phase", serverId: server.id, ts: new Date().toISOString(),
            data: { from: prevPhase, to: plan.phase, count: plan.liveCount, target: config.seedTarget },
          });
        }
        phaseSettled = news.settled;
        prevPhase = plan.phase;
        pendingPhase = plan.pendingPhase;
        pendingSinceMs = plan.pendingSinceMs;

        // Dry-run = config toggle OR the server isn't active. Same rule the enforcer uses.
        const dryRun = config.dryRun || server.engagementMode !== "active";

        // 1) Accrue seed presence (writes to OUR db only — always allowed). One statement for the
        //    whole roster: per-player this was ~40 upserts every 30s tick on a busy seed, the last
        //    real N+1 in the workers.
        if (plan.progressAdds.length) {
          await repo.seeding.addProgressMany(
            server.id,
            plan.progressAdds.map((a) => ({ playerId: a.playerId, playerName: a.name || null, deltaSeconds: a.deltaSec })),
          ).catch(() => {});
        }

        // Placeholders in the greeting and the warn/punish/kick lines, filled per player — one
        // renderer per tick, so a batch shares its reads (and a text with no tokens reads nothing).
        const seedRenderer = rendererFor(repo, server, client);

        // 2) One-time seeding announcements.
        for (const an of plan.announces) {
          if (dryRun) continue; // a greeting is cosmetic; don't spam audit on observe/dry-run
          try { await client.execute("messagePlayer", { playerId: an.playerId, message: await seedRenderer.render(an.message, { playerId: an.playerId, playerName: an.name }) }); }
          catch (e) { slog.warn("a player was not told the seeding rules", { playerId: an.playerId, err: (e as Error).message }); }
        }

        // 3) Enforcement: warn / punish / kick.
        // Signed like a manual action would be — minus the staff line, since the app has no name.
        // A seeding kick that says only "seeding rules" leaves the player nowhere to ask why.
        const sigCfg = plan.actions.length ? await repo.signatures.get().catch(() => null) : null;
        for (const act of plan.actions) {
          const cmd = act.kind === "warn" ? "messagePlayer" : act.kind === "punish" ? "punishPlayer" : "kickPlayer";
          // Signed THEN rendered — the order every staff action uses — so a placeholder written into
          // the signature ({server_name}, say) fills here too, not only on manual actions.
          const unsigned = sigCfg ? automatedSignerFrom(sigCfg, act.kind === "warn" ? "message" : act.kind)(act.message) : act.message;
          const signed = await seedRenderer.render(unsigned, { playerId: act.playerId, playerName: act.name });
          // Each row names the rule and what the player did (seedActionAudit), not just "seeding rule".
          if (dryRun) {
            await repo.audit.create(seedActionAudit(act, server.id, true)).catch(() => {});
            continue;
          }
          try {
            await client.execute(cmd, { playerId: act.playerId, message: signed, reason: signed });
            await repo.audit.create(seedActionAudit(act, server.id, false)).catch(() => {});
            // A kick removed somebody: the phone's "automatic kicks and bans" hears it. Not
            // app.enforcement, which is the Rules tab's and its Discord alert's.
            if (act.kind === "kick") bus.emit("app.seeding.kick", { kind: "app.seeding.kick", serverId: server.id, ts: new Date().toISOString(), actorPlayerId: act.playerId, actorName: act.name });
          } catch (e) {
            slog.warn("seed enforcement failed", { kind: act.kind, playerId: act.playerId, err: (e as Error).message });
          }
        }

        /*
         * 4) Rewards on seeding→live, in the two currencies a community can pay in — VIP time and
         *    community points — independently. Either, both, or (with the reward off) neither.
         *
         *    Points live on a DISCORD account, so paying them means resolving the seeder's link;
         *    somebody who has never linked cannot be credited, still gets the VIP half if there is
         *    one, and the skip is written onto their reward row rather than being silent.
         *
         *    PAID ONCE. Two guards, and they cover different things. Every credit carries a `ref`,
         *    so a second application of the same credit inside one round is a no-op and the ledger
         *    row traces back to the round that made it. Across rounds it is the reward-delay
         *    debounce — `lastRewardAt` — that stops a population flapping over the go-live line
         *    from being paid twice.
         *
         *    Which is why the debounce is stamped BEFORE the first payment rather than after the
         *    loop. It is read back from the store on every tick, so a worker that died half way
         *    through paying used to come back, find no stamp, re-detect the transition and pay
         *    everyone it had ALREADY paid a second time — cumulative VIP stacking twice, and now
         *    the points with it. The ref cannot help there: the retry is a new round with a new
         *    timestamp. Stamping first turns that crash into some seeders going unpaid, which is
         *    the error worth having. Step 6 writes the same value again at the end of the tick;
         *    this is not that write's replacement, it is its insurance.
         */
        /*
         * PAY LAST SEED — the missed-payout lever. Staff queued a replay of the archived cycle
         * (the API validated it: unpaid, somebody qualified) and the worker honours it here, so
         * the payment runs through EXACTLY the machinery a live round uses — the VIP absorb
         * rules, points, bridge stops, receipts and all. The cycle is marked paid BEFORE the
         * first grant, the same insurance the reward-delay stamp buys: a worker that dies mid-
         * round leaves some seeders unpaid (re-queueable is the dangerous direction, unpaid is
         * the recoverable one). The reward-delay stamp is NOT consumed by a replay — a genuine
         * go-live minutes later must still pay its own round.
         */
        let manualRewards: RewardTarget[] = [];
        // What the replay is doing, so its outcome can be written back onto the archived cycle
        // once the payments are done: "full" pays the whole unpaid cycle, "retry" only the parts
        // of it a finished round still owes.
        let replay: { mode: "full" | "retry"; cycle: SeedCycleRecord } | null = null;
        // The consuming UPDATE only runs when the state row (already read this tick) says a
        // request is waiting — it used to be a write statement on every tick of every server.
        if (prevState?.payRequested && await repo.seeding.takePayRequest(server.id).catch(() => false)) {
          const cycle = plan.rewards.length === 0 ? await repo.seeding.getLastCycle(server.id).catch(() => null) : null;
          // Re-judged HERE, not only at the click: a cycle archived between the request and this
          // tick is a different cycle, and paying it on the strength of the old one's check is how
          // a round already paid would be paid again.
          const refusal = plan.rewards.length === 0 ? seedCycleReplayRefusal(cycle) : null;
          const owed = plan.rewards.length === 0 ? seedCycleRetryable(cycle) : [];
          if (plan.rewards.length > 0) {
            slog.warn("seed pay-last: a real reward round fired this same tick — the replay is skipped");
          } else if (!refusal && cycle) {
            const need = config.minSeedMinutes * 60;
            manualRewards = cycle.entries
              .filter((e) => e.seconds >= need)
              .map((e) => ({ playerId: e.playerId, name: e.name ?? "" }));
            slog.info("seed pay-last: replaying the archived cycle's reward round", { qualifying: manualRewards.length, endedAt: cycle.endedAt });
            if (manualRewards.length && !dryRun) {
              replay = { mode: "full", cycle };
              await repo.seeding.setLastCycle(server.id, { ...cycle, rewarded: true, failed: [] }).catch(() => {});
            }
          } else if (cycle && owed.length) {
            // Only what is still OWED, part by part: a seeder whose VIP landed and whose points
            // did not is retried for points alone — re-running the VIP would stack the time twice.
            manualRewards = owed.map((f) => ({
              playerId: f.playerId, name: f.name ?? "",
              skipVip: !f.needVip, skipPoints: !f.needPoints, skipBridge: !f.needBridge, retry: true,
            }));
            slog.info("seed pay-last: retrying the seeders the last round did not finish paying", { retrying: owed.length, endedAt: cycle.endedAt });
            if (!dryRun) {
              replay = { mode: "retry", cycle };
              // Cleared BEFORE paying, the same insurance the full replay buys: a crash mid-retry
              // leaves seeders unpaid (recoverable) rather than re-queueable (double pay).
              await repo.seeding.setLastCycle(server.id, { ...cycle, failed: [] }).catch(() => {});
            }
          } else {
            slog.warn(`seed pay-last: not replayed — ${refusal ?? "nothing owed"}`);
          }
        }
        /*
         * THE REPEAT WINDOW. The population dropped and came back within rewardDelaySec of a paid
         * round: whoever was already paid in that window is THANKED ("the server is seeded"), not
         * paid again, and everyone else who seeded long enough is paid as normal — a player who
         * joined for the second push is not left with nothing, which is what suppressing the whole
         * round used to do. Read from the reward rows themselves, so it holds across restarts and
         * covers a round a crash interrupted half way through.
         */
        let roundRewards: RewardTarget[] = plan.rewards.length ? plan.rewards : manualRewards;
        let repeatSeeders: RewardTarget[] = [];
        if (plan.rewards.length && config.rewardDelaySec > 0) {
          const since = new Date(now - config.rewardDelaySec * 1000).toISOString();
          const paidRows = await repo.audit.list({ actions: ["seed.reward"], serverId: server.id, from: since, limit: 500 }).catch(() => null);
          if (paidRows) {
            ({ pay: roundRewards, repeat: repeatSeeders } = splitRepeatSeeders(plan.rewards, seedPaidPlayers(paidRows)));
          } else if (prevState?.lastRewardAt && now - Date.parse(prevState.lastRewardAt) < config.rewardDelaySec * 1000) {
            // Who was paid could not be read, and a round WAS paid inside the window: thank
            // everyone rather than risk paying the same people twice. Unpaid is recoverable
            // (Pay last seed); paid twice is not.
            slog.warn("seed reward: could not read who was paid in the repeat window — this round thanks everyone instead of risking a double payment");
            repeatSeeders = plan.rewards;
            roundRewards = [];
          }
        }

        if (plan.rewarded && !dryRun) {
          await repo.seeding.setState({
            serverId: server.id, phase: plan.phase, liveCount: plan.liveCount, seederCount: plan.seederCount,
            lastRewardAt: new Date(now).toISOString(), updatedAt: new Date().toISOString(),
          }).catch(() => {});
        }
        const payHours = Math.max(0, config.rewardHours);
        const payPoints = Math.max(0, config.rewardPoints ?? 0);
        // Read once per round, not per seeder: the cap and the currency's name are config. Read
        // whenever there is a round rather than only for a points one, because `{currency}` is a
        // token ANY reward message may use — a VIP-only server whose message mentions it was
        // getting the fallback word instead of what the community calls its currency.
        const ecoCfg = roundRewards.length ? await repo.economy.config().catch(() => null) : null;
        const currencyName = ecoCfg?.currencyName || "Points";
        // The server's zone (its Auto settings one, else the community's) renders each seeder’s
        // new VIP expiry in the reward message — read once per round, and only when a VIP half
        // exists to date.
        const rewardTz = roundRewards.length && payHours > 0 ? await serverTimezone(repo, server.id) : null;
        const roundRef = `seed:${server.id}:${new Date(now).toISOString()}`;
        /*
         * The BRIDGE: extra servers this round also pays VIP on, each with its own hours.
         * Targets resolve once per round — a stop that has been retired (or deleted) since it
         * was saved drops out here with its reason, and every seeder's receipt carries it, so a
         * bridge quietly going dark is a written fact rather than a mystery. Each live target
         * gets ONE connection for the whole round, dialed lazily on the first grant that needs
         * it; a dial that fails poisons that stop for the round instead of re-timing-out per
         * seeder.
         */
        const bridgeCfg = roundRewards.length ? (config.rewardBridge ?? []).filter((t) => t.hours > 0) : [];
        const bridgeStops: { target: ServerRow; hours: number; client: ReturnType<typeof gameClientFor>; connected: boolean; dead: string | null }[] = [];
        const bridgeDark: { serverId: string; hours: number; skipped: string }[] = [];
        for (const t of bridgeCfg) {
          const target = await repo.servers.findById(t.serverId).catch(() => null);
          if (!target) { bridgeDark.push({ serverId: t.serverId, hours: t.hours, skipped: "target server no longer exists" }); continue; }
          if (target.retiredAt) { bridgeDark.push({ serverId: t.serverId, hours: t.hours, skipped: `${target.name} is retired — a parked server takes no new payouts` }); continue; }
          bridgeStops.push({ target, hours: t.hours, client: gameClientFor(target), connected: false, dead: null });
        }
        const bridgeCrossGame = bridgeStops.some((b) => b.target.game !== server.game);
        /*
         * Seed presence is keyed by the GAME's platform id — the same id `addVip` and every other
         * RCON command take — while a Discord link hangs off our internal player row. Resolved
         * that once per ROUND rather than inside the payment loop, and kept in a map so the two id
         * spaces cannot be confused for each other, which is the mistake that once made the
         * kill-rule enforcer act on nobody.
         *
         * The player rows come back in one query; their links are still one read each, because the
         * store has no bulk forward link lookup. A reward round happens once per seed cycle for
         * the handful of people who qualified, so that is a fine place to pay it.
         */
        const discordByPlatformId = new Map<string, string>();
        /*
         * Seeders whose Discord link could not be READ this round — which is not the same fact as
         * "has no Discord link", and the two used to collapse into one. A hiccup on either query
         * made a linked seeder look unlinked, so they were told in game that they missed their
         * points because they had not linked an account they had in fact linked, and the reward
         * row recorded that as the reason. Held separately so neither the message nor the record
         * says something we do not know.
         */
        const linkUnknown = new Set<string>();
        /** Every game account each seeder's Discord holds — the cross-game half of the bridge. */
        const accountsByPlatformId = new Map<string, { game: string; platformId: string }[]>();
        if ((payPoints > 0 || bridgeCrossGame) && roundRewards.length) {
          const wanted = roundRewards.map((r) => r.playerId);
          let rows: Awaited<ReturnType<typeof repo.players.findByPlatformIds>> = [];
          try {
            rows = await repo.players.findByPlatformIds(wanted);
          } catch (err) {
            for (const id of wanted) linkUnknown.add(id);
            slog.warn("seed reward: could not read the seeders' player rows — points held over this round", { err: (err as Error).message });
          }
          for (const row of rows) {
            try {
              const link = (await repo.externalLinks.list(row.id)).find((l) => l.provider === "discord")?.externalId;
              if (link) {
                discordByPlatformId.set(row.platformId, link);
                // Only when a cross-game stop will ask: the same resolution the VIP shop runs,
                // Discord as the hub and each game's link supplying that game's id.
                if (bridgeCrossGame) {
                  const accounts = await repo.externalLinks.findPlayers("discord", link);
                  accountsByPlatformId.set(row.platformId, accounts.map((a) => ({ game: a.game, platformId: a.platformId })));
                }
              }
            } catch (err) {
              linkUnknown.add(row.platformId);
              slog.warn("seed reward: could not read a seeder's Discord link — points held over this round", { playerId: row.platformId, err: (err as Error).message });
            }
          }
        }
        // A retry pays under the ORIGINAL round's id: its receipts join that round, and a points
        // credit the round already landed is recognised by the ledger's ref instead of paid twice.
        const payRef = replay?.mode === "retry" && replay.cycle.round ? replay.cycle.round : roundRef;
        const failures: SeedFailure[] = [];
        for (const rw of roundRewards) {
          // This seeder's amounts: the config's, minus any part a retry already knows was paid.
          const rwHours = rw.skipVip ? 0 : payHours;
          const rwPoints = rw.skipPoints ? 0 : payPoints;
          // Which parts have COMPLETED — read by the catch, so a failure records exactly what is
          // still owed. A part with nothing to pay is complete from the start.
          let vipDone = rwHours <= 0;
          let pointsDone = rwPoints <= 0;
          let bridgeDone = rw.skipBridge === true || !(bridgeStops.length || bridgeDark.length);
          /*
           * The phrase is worked out PER PLAYER, not per round, because the two halves do not
           * always both land: an unlinked seeder gets the VIP and no points. Telling them they
           * were "granted 24h of VIP and 500 Points" when 500 points went nowhere is the kind of
           * message that turns a missing reward into a support conversation.
           */
          const discordId = rwPoints > 0 ? discordByPlatformId.get(rw.playerId) ?? null : null;
          const theirPoints = rwPoints > 0 && discordId ? rwPoints : 0;
          // Two different reasons the points did not land, and only one of them is the player's to
          // fix (see pointsSkipReason).
          const linkUnreadable = rwPoints > 0 && !discordId && linkUnknown.has(rw.playerId);
          const pointsSkippedWhy = pointsSkipReason({ points: rwPoints, discordId, linkReadable: !linkUnreadable });
          try {
            /*
             * ONE read decides the whole VIP half: what stands, whether it is permanent, whether
             * it is paused — inside the try, so a read that FAILS skips this seeder's round (the
             * catch logs it, the next round retries) instead of being read as "has no VIP". That
             * misreading is not hypothetical: this row's expiration used to be flattened to null
             * on the way into calcRewardExpiration, and a PAID PERMANENT grant was rewritten to
             * a 72-hour one and later swept out of the game as expired.
             */
            const existingVip = rwHours > 0 ? await repo.vips.get(server.id, rw.playerId) : null;
            const expiration = rwHours > 0 ? calcRewardExpiration(existingVip, rwHours, config.rewardCumulative, now) : null;
            // Permanent absorbs the reward: nothing to write, and nothing to promise — the
            // message must not tell a permanent VIP they were "granted 72h". Permanent VIP a group
            // perk holds is different: the hours join the VIP they get back on leaving the group —
            // unless the group's perk takes no rewards, when it absorbs them like their own would.
            const holdRefuses = existingVip?.groupHold ? await rewardsRefusedBy(repo, existingVip.groupHold) : [];
            const vipHeld = rwHours > 0 && !!existingVip?.groupHold && !holdRefuses.length;
            const vipAbsorbed = rwHours > 0 && expiration === null && !vipHeld;
            const vipHours = vipAbsorbed ? 0 : rwHours;
            const phrase = rewardPhrase(vipHours, theirPoints, currencyName);
            // Every bridge stop's decision for THIS seeder, taken with no side effects — so the
            // dry-run reports the same truth the live path acts on. `linkedAccounts` is null only
            // when the links could not be READ (never paid-as-unlinked), [] when there is no
            // Discord link at all; same-game stops ignore it entirely.
            const bridgePlan = !rw.skipBridge && (bridgeStops.length || bridgeDark.length) ? [
              ...bridgeDark.map((d) => ({ stop: null as (typeof bridgeStops)[number] | null, serverId: d.serverId, server: null as string | null, hours: d.hours, playerId: null as string | null, skipped: d.skipped as string | null })),
              ...bridgeStops.map((b) => {
                const who = bridgeAccountFor({
                  targetGame: b.target.game, seededGame: server.game, seederPlatformId: rw.playerId,
                  linkedAccounts: linkUnknown.has(rw.playerId) ? null : accountsByPlatformId.get(rw.playerId) ?? [],
                  gameLabel: getGame(b.target.game)?.label ?? b.target.game,
                });
                return { stop: b, serverId: b.target.id, server: b.target.name, hours: b.hours, playerId: who.playerId, skipped: who.skipped };
              }),
            ] : [];
            if (dryRun) {
              await repo.audit.create({
                actorUserId: null, actorName: "seeding", action: "seed.reward",
                targetType: "player", targetId: rw.playerId, targetName: rw.name || undefined, serverId: server.id,
                summary: `[dry-run] would grant ${phrase || "nothing"} to ${rw.name || rw.playerId} (seed reward)${vipAbsorbed ? " — VIP untouched, already permanent" : ""}${pointsSkippedWhy ? ` — points skipped, ${pointsSkippedWhy}` : ""}`,
                data: { round: payRef, expiration, hours: rwHours, points: rwPoints, wouldPay: theirPoints, dryRun: true, ...(vipAbsorbed ? { vipSkipped: "already permanent" } : {}), ...(pointsSkippedWhy ? { pointsSkipped: pointsSkippedWhy } : {}), ...(bridgePlan.length ? { bridge: bridgePlan.map(({ stop: _s, ...rest }) => rest) } : {}) },
              }).catch(() => {});
              continue;
            }
            // `points` is what the config gives a qualifying seeder; `pointsApplied`/`pointsSkipped`
            // are what happened to THIS one. Recording only the outcome lost the amount they were
            // due, which is the first thing anybody asks when a reward is queried.
            const detail: Record<string, unknown> = { hours: rwHours, points: rwPoints, round: payRef, ...(manualRewards.length ? { manual: true } : {}), ...(rw.retry ? { retry: true } : {}) };
            if (rwHours > 0) {
              // Held by a group perk: the hours go to the frozen balance. A hold that ended since the
              // read (they just left the group) is read again, so the reward lands on the row its
              // release left — never stacked onto the permanent it replaced.
              const basis = vipHeld ? await bankIfHeld(repo, server.id, rw.playerId, config.rewardCumulative ? { addMs: rwHours * 3_600_000 } : { atLeastMs: rwHours * 3_600_000 }, { reward: true }) : null;
              const baseVip = basis && !basis.banked ? basis.existing : existingVip;
              const vipExpiration = basis && !basis.banked ? calcRewardExpiration(baseVip, rwHours, config.rewardCumulative, now) : expiration;
              const refusedBy = holdRefuses.length ? holdRefuses : basis?.refusedBy ?? [];
              if (basis?.banked) {
                detail.groupHeld = true;
                detail.bankedMs = basis.banked.groupHold!.bankedMs;
                vipDone = true;
              } else if (vipAbsorbed || vipExpiration === null) {
                detail.vipSkipped = refusedBy.length
                  ? `permanent VIP from group ${refusedBy.map((n) => `"${n}"`).join(", ")}, whose perk takes no rewards`
                  : "already permanent — a seed reward never rewrites a permanent grant";
                vipDone = true;
              } else {
                // A paused VIP still EARNS the reward (the row's expiration extends below) but the
                // game entry stays off until the pause lapses — the timeout would otherwise be
                // cancelled by the very next seed round.
                const vipPaused = Boolean(baseVip?.pausedUntil && Date.parse(baseVip.pausedUntil) > Date.now());
                /*
                 * The game call is ISOLATED. It used to share this seeder's one try with the store
                 * write, the points and the receipt, so a refused AddVip dropped all of them — no
                 * VIP, no points, and not a single row saying so. Exactly the permanent VIPs (who
                 * skip this call) came out the other side, which is how a field round paid "only
                 * staff". Now: a seeder who ALREADY holds a dated grant is already in the game's
                 * list (the likeliest refusal), so the extension is stored and the refusal noted;
                 * a brand-new grant the game refused is NOT stored — the panel must not claim VIP
                 * the player does not have in game — and the receipt says why. Points and the
                 * receipt go ahead either way.
                 */
                let gameErr: string | null = null;
                if (!vipPaused) {
                  try { await client.execute("addVip", { playerId: rw.playerId, description: rw.name || "VIP" }); }
                  catch (e) { gameErr = (e as Error).message; }
                }
                if (gameErr && !baseVip) {
                  detail.vipFailed = `the game refused the VIP grant: ${gameErr}`;
                  slog.warn("seed reward: the game refused a new VIP grant — not stored", { playerId: rw.playerId, err: gameErr });
                } else {
                  if (gameErr) detail.vipGameNote = `the game answered ${gameErr} — they already hold VIP there, so the extension was stored`;
                  // comment/name fill a NEW row only (the store COALESCEs a null): an extension
                  // must not restamp "seed reward" over the provenance of the grant it extends —
                  // the VIPs page's "by" column is how staff tell a bought grant from a reward.
                  const row = await repo.vips.upsert({
                    serverId: server.id, playerId: rw.playerId,
                    playerName: baseVip ? null : (rw.name || null), comment: baseVip ? null : "seed reward",
                    expiration: vipExpiration, createdByUserId: null, createdByName: "seeding",
                  });
                  // A hold that began after the read took the hours into its frozen balance;
                  // permanent VIP granted meanwhile absorbed them (the store's floor kept it).
                  if (row.groupHold) { detail.groupHeld = true; detail.bankedMs = row.groupHold.bankedMs; }
                  else if (row.expiration === null) detail.vipSkipped = "already permanent — a seed reward never rewrites a permanent grant";
                  else detail.expiration = row.expiration; // what landed — the store keeps the later date
                  vipDone = true;
                }
              }
            }
            if (rwPoints > 0) {
              // A seeder who has never linked Discord has no balance to credit. Recorded either
              // way, because "why didn't I get my points" is the question this row has to answer.
              if (!discordId) {
                detail.pointsSkipped = pointsSkippedWhy;
                // No link is the player's to fix (not owed); a link we could not READ is ours — owed.
                pointsDone = !linkUnreadable;
                if (linkUnreadable) detail.pointsOwed = true;
              } else {
                const out = await repo.economy.apply(
                  {
                    discordId,
                    delta: rwPoints,
                    reason: `Seed reward on ${server.name}`,
                    ref: `${payRef}:${rw.playerId}`,
                    actorName: "seeding",
                  },
                  { maxBalance: ecoCfg?.balanceCap ?? null },
                );
                // `applied: false` means this exact credit is already in the ledger — a retry
                // inside one round, not a payment that failed. The amount is on the standing entry
                // either way, so it is always recorded; the flag says which of the two happened.
                detail.pointsApplied = out.entry.delta;
                if (!out.applied) detail.pointsAlreadyApplied = true;
                detail.balance = out.member.balance;
                pointsDone = true;
                // A credit the cap ate is not the credit that was promised; say so on the row.
                if (out.applied && out.entry.delta < rwPoints) detail.pointsCapped = true;
              }
            }
            /*
             * The bridge slices. Each row that CHANGES on a target server gets its own
             * seed.reward receipt scoped to that server — its VIP history and integrity scan
             * must stay self-explanatory without knowing the bridge exists — and every slice,
             * landed or skipped, is written onto this seeder's own row under `bridge`. The
             * grant rules are the seeded server's, verbatim: permanent absorbs, paused banks
             * the time without reappearing in game, and calcRewardExpiration never shortens.
             */
            const bridgeTold: { server: string | null; hours: number; landed: boolean; tell: string | null }[] = [];
            if (bridgePlan.length) {
              const bridgeOut: Record<string, unknown>[] = [];
              for (const slice of bridgePlan) {
                const stop = slice.stop;
                if (!stop) { bridgeOut.push({ serverId: slice.serverId, ...(slice.server ? { server: slice.server } : {}), hours: slice.hours, skipped: slice.skipped ?? "unresolved" }); bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: null }); continue; }
                if (!slice.playerId) {
                  bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, skipped: slice.skipped ?? "unresolved" });
                  // An unreadable link is ours to fix and stays out of the message; a missing link
                  // or registration is the player's, and telling them is what makes it fixable.
                  bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: linkUnknown.has(rw.playerId) ? null : slice.skipped });
                  continue;
                }
                if (stop.dead) { bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, skipped: stop.dead }); bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: null }); continue; }
                try {
                  // Permanent VIP from a group perk there: the hours bank for when they leave it (a
                  // hold that ended since the read is read again — see bankIfHeld).
                  const bankedThere = async (row: VipRow) => {
                    await repo.audit.create({
                      actorUserId: null, actorName: "seeding", action: "seed.reward",
                      targetType: "player", targetId: slice.playerId!, targetName: rw.name || undefined, serverId: stop.target.id,
                      summary: `granted ${slice.hours}h of VIP to ${rw.name || slice.playerId} on ${stop.target.name} (seed reward bridge from ${server.name}) — they hold permanent VIP from a group perk there, so it waits for them when they leave it`,
                      data: { bridgeFrom: server.id, hours: slice.hours, groupHeld: true, bankedMs: row.groupHold!.bankedMs, playerId: slice.playerId },
                    }).catch(() => {});
                    bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, groupHeld: true });
                    bridgeTold.push({ server: stop.target.name, hours: slice.hours, landed: true, tell: null });
                  };
                  // A group perk there that takes no rewards holds the grant like their own permanent.
                  const basis = await bankIfHeld(repo, stop.target.id, slice.playerId, config.rewardCumulative ? { addMs: slice.hours * 3_600_000 } : { atLeastMs: slice.hours * 3_600_000 }, { reward: true });
                  if (basis.banked) { await bankedThere(basis.banked); continue; }
                  const standing = basis.existing;
                  const exp = calcRewardExpiration(standing, slice.hours, config.rewardCumulative, now);
                  if (exp === null) {
                    bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, vipSkipped: basis.refusedBy ? `permanent VIP from group ${basis.refusedBy.map((n) => `"${n}"`).join(", ")}, whose perk takes no rewards` : "already permanent — a seed reward never rewrites a permanent grant" });
                    bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: "your VIP there is already permanent" });
                    continue;
                  }
                  const bridgePaused = Boolean(standing?.pausedUntil && Date.parse(standing.pausedUntil) > Date.now());
                  if (!bridgePaused) {
                    if (!stop.connected) { await connectGameClient(stop.client, stop.target); stop.connected = true; }
                    await stop.client.execute("addVip", { playerId: slice.playerId, description: rw.name || "VIP" });
                  }
                  const landed = await repo.vips.upsert({
                    serverId: stop.target.id, playerId: slice.playerId,
                    playerName: standing ? null : (rw.name || null), comment: standing ? null : "seed reward bridge",
                    expiration: exp, createdByUserId: null, createdByName: "seeding",
                  });
                  if (landed.groupHold) { await bankedThere(landed); continue; }
                  // Permanent VIP granted there since the read: the store kept it, and nothing landed.
                  if (landed.expiration === null) {
                    bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, vipSkipped: "already permanent — a seed reward never rewrites a permanent grant" });
                    bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: "your VIP there is already permanent" });
                    continue;
                  }
                  await repo.audit.create({
                    actorUserId: null, actorName: "seeding", action: "seed.reward",
                    targetType: "player", targetId: slice.playerId, targetName: rw.name || undefined, serverId: stop.target.id,
                    summary: `granted ${slice.hours}h of VIP to ${rw.name || slice.playerId} on ${stop.target.name} (seed reward bridge from ${server.name})`,
                    data: { bridgeFrom: server.id, hours: slice.hours, expiration: landed.expiration, playerId: slice.playerId },
                  }).catch(() => {});
                  bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, expiration: landed.expiration });
                  bridgeTold.push({ server: stop.target.name, hours: slice.hours, landed: true, tell: null });
                } catch (e) {
                  // A dial that failed poisons this stop for the ROUND — one timeout, not one per
                  // seeder — and the slice's receipt carries the target's own refusal verbatim:
                  // "observe mode" is not "could not reach", and the difference is who has
                  // something to fix.
                  if (!stop.connected) stop.dead = `${stop.target.name}: ${(e as Error).message}`;
                  bridgeOut.push({ serverId: slice.serverId, server: slice.server, hours: slice.hours, skipped: `${stop.target.name}: ${(e as Error).message}` });
                  bridgeTold.push({ server: slice.server, hours: slice.hours, landed: false, tell: null });
                  slog.warn("seed reward bridge failed", { target: stop.target.id, playerId: slice.playerId, err: (e as Error).message });
                }
              }
              detail.bridge = bridgeOut;
            }
            bridgeDone = true;
            // Composed AFTER the payment, so the numbers the player reads are the numbers that
            // happened — the credited amount (which the cap may have trimmed) and the balance it
            // produced. The wording rules live in composeRewardMessage; this hands it the facts.
            const vipLanded = !detail.vipFailed;
            // From what happened, not from the first read: a re-read that found permanent VIP
            // absorbed the hours, and hours banked into a group perk's hold have no date to show.
            const absorbedNow = vipAbsorbed || Boolean(detail.vipSkipped);
            const landedUntil = typeof detail.expiration === "string" ? detail.expiration : null;
            const message = composeRewardMessage({
              playerName: rw.name, hours: vipLanded && !absorbedNow ? vipHours : 0, points: rwPoints, linked: Boolean(discordId),
              vipUntil: vipLanded && landedUntil ? formatVipUntil(landedUntil, rewardTz, now) : null,
              vipAbsorbed: absorbedNow,
              credited: detail.pointsApplied === undefined ? null : Number(detail.pointsApplied),
              balance: detail.balance === undefined ? null : Number(detail.balance),
              currencyName, message: config.rewardMessage,
              linkedNote: config.rewardLinkedNote,
              // Only somebody we KNOW has no Discord gets told to go link one. When the lookup
              // failed we say nothing about it — the VIP half of the message still goes out.
              unlinkedNote: linkUnreadable ? "" : config.rewardUnlinkedNote,
            });
            const fullMessage = [message, bridgeBonusLine(bridgeTold)].filter(Boolean).join(" ");
            // Rendered AFTER the VIP write, so {vip_until}/{vip_remaining} typed into the message read
            // the new expiry — the renderer's VIP list is fresh for the reward round.
            if (fullMessage) await client.execute("messagePlayer", { playerId: rw.playerId, message: await rendererFor(repo, server, client, payRef).render(fullMessage, { playerId: rw.playerId, playerName: rw.name }) }).catch(() => {});
            await repo.audit.create({
              actorUserId: null, actorName: "seeding", action: "seed.reward",
              targetType: "player", targetId: rw.playerId, targetName: rw.name || undefined, serverId: server.id,
              summary: `granted ${detail.vipFailed || absorbedNow ? rewardPhrase(0, theirPoints, currencyName) || "nothing" : phrase || "nothing"} to ${rw.name || rw.playerId} (seed reward)${detail.vipSkipped ? " — VIP untouched, already permanent" : ""}${detail.vipFailed ? ` — VIP NOT granted, ${String(detail.vipFailed)}` : ""}${detail.pointsSkipped ? ` — points skipped, ${detail.pointsSkipped}` : ""}`,
              data: detail,
            }).catch(() => {});
            slog.info("seed reward", { playerId: rw.playerId, ...detail });
            // Consecutive-seeding game reward: today counts once the seed reward itself is paid.
            await rewardSeedDay(repo, server, client, slog, rw.playerId, rw.name || null, replay ? Date.parse(replay.cycle.endedAt) : undefined)
              .catch((err) => slog.warn("seed-days reward failed", { playerId: rw.playerId, err: (err as Error).message }));
            if (!vipDone || !pointsDone) {
              failures.push({
                playerId: rw.playerId, name: rw.name || null, needVip: !vipDone, needPoints: !pointsDone, needBridge: !bridgeDone,
                reason: detail.vipFailed ? String(detail.vipFailed) : "their Discord link could not be read, so the points were held",
              });
            }
          } catch (e) {
            slog.warn("seed reward failed", { playerId: rw.playerId, err: (e as Error).message });
            // Never silent again: the seeder who got nothing gets a row saying so, with the error,
            // so "why wasn't I paid" has an answer on the trail and in the payouts view.
            await repo.audit.create({
              actorUserId: null, actorName: "seeding", action: "seed.reward",
              targetType: "player", targetId: rw.playerId, targetName: rw.name || undefined, serverId: server.id,
              summary: `seed reward FAILED for ${rw.name || rw.playerId}: ${(e as Error).message}`,
              data: { round: payRef, failed: (e as Error).message, hours: rwHours, points: rwPoints, ...(rw.retry ? { retry: true } : {}) },
            }).catch(() => {});
            failures.push({ playerId: rw.playerId, name: rw.name || null, needVip: !vipDone, needPoints: !pointsDone, needBridge: !bridgeDone, reason: (e as Error).message });
          }
        }
        for (const b of bridgeStops) if (b.connected) await b.client.disconnect().catch(() => {});
        // The already-paid of a repeat round: one "server is seeded" message each, and one line on
        // the record saying who was thanked instead of paid, and why.
        // Seeders the window paid only PART of (the game refused their VIP last time) are in the
        // paid list with the landed part skipped — named on the record as finishing a payment.
        const topUps = roundRewards.filter((r) => !r.retry && (r.skipVip || r.skipPoints)).length;
        if (repeatSeeders.length || topUps) {
          const windowLabel = seedWindowLabel(config.rewardDelaySec);
          const text = (config.rewardRepeatMessage ?? "").trim();
          if (!dryRun && text) {
            for (const r of repeatSeeders) {
              const filled = applyVars(text, { window: windowLabel });
              await client.execute("messagePlayer", { playerId: r.playerId, message: await seedRenderer.render(filled, { playerId: r.playerId, playerName: r.name }) }).catch(() => {});
            }
          }
          await repo.audit.create({
            actorUserId: null, actorName: "seeding", action: "seed.repeat",
            targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
            summary: `${dryRun ? "[dry-run] " : ""}seeded again within ${windowLabel} of the last reward — ${roundRewards.length - topUps} new seeder(s) paid${topUps ? `, ${topUps} paid the part the last round could not` : ""}; ${repeatSeeders.length} already paid in that window thanked instead: ${repeatSeeders.slice(0, 20).map((r) => r.name || r.playerId).join(", ")}${repeatSeeders.length > 20 ? "…" : ""}`,
            data: { windowSec: config.rewardDelaySec, paid: roundRewards.length - topUps, toppedUp: topUps, thanked: repeatSeeders.map((r) => ({ playerId: r.playerId, name: r.name })), dryRun },
          }).catch(() => {});
          slog.info("seed reward: repeat round", { paid: roundRewards.length - topUps, toppedUp: topUps, thanked: repeatSeeders.length });
        }
        if (replay) {
          await repo.seeding.setLastCycle(server.id, {
            ...replay.cycle, rewarded: true, round: replay.cycle.round ?? roundRef, failed: failures,
          }).catch(() => {});
          if (failures.length) slog.warn("seed pay-last: some seeders are still owed — retry again once the cause is fixed", { owed: failures.length });
        }

        // 5) End the cycle if the plan says so (→live after rewards, or →idle) — archived
        //    FIRST, so a payout the transition missed stays replayable ("pay last seed").
        if (plan.clearProgress) {
          if (progressRows.length) {
            await repo.seeding.setLastCycle(server.id, {
              // A dry-run round granted nothing, so it is recorded as NOT paid — "dry-run was left
              // on" is the commonest missed payout, and exactly the one a replay should cover.
              endedAt: new Date(now).toISOString(), rewarded: plan.rewarded && !dryRun,
              wentLive: plan.phase === "live", debounced: plan.rewardDebounced === true,
              ...(plan.rewards.length && !dryRun ? { round: roundRef, failed: failures } : {}),
              entries: progressRows.slice(0, 500).map((r) => ({ playerId: r.playerId, name: r.playerName, seconds: r.seconds })),
            }).catch(() => {});
          }
          await repo.seeding.clearProgress(server.id).catch(() => {});
        }

        // 6) Publish live phase/counts for the UI. Stamp lastRewardAt when a reward round fired so
        //    the reward-delay debounce persists across ticks, phase flaps, and worker restarts.
        const lastRewardAt = plan.rewarded ? new Date(now).toISOString() : (prevState?.lastRewardAt ?? null);
        // Written when something CHANGED, or every few minutes as a heartbeat — the row used to be
        // rewritten on every tick of every server with identical values, most of all overnight.
        const stateSig = `${plan.phase}|${plan.liveCount}|${plan.seederCount}|${lastRewardAt ?? ""}`;
        if (stateSig !== lastStateSig || now - lastStateWriteMs >= STATE_HEARTBEAT_MS) {
          await repo.seeding.setState({ serverId: server.id, phase: plan.phase, liveCount: plan.liveCount, seederCount: plan.seederCount, lastRewardAt, updatedAt: new Date().toISOString() })
            .then(() => { lastStateSig = stateSig; lastStateWriteMs = now; })
            .catch(() => {});
        }

        // Fast while a chase rule is armed mid-seed, slow otherwise — the wave tactic the field
        // report described (edge OPs, respawn, run back in) lives entirely between slow ticks.
        // Each server's own check speed when staff set one in the app (read fresh every tick, so
        // a change applies at the next check), else the install's defaults.
        await ctl.sleep(seedCheckDelayMs(plan.phase, config, { fastMs: SEED_FAST_POLL_MS, slowMs: SEED_POLL_MS }, plan.paceArmed === true));
      }
    } catch (err) {
      slog.error("seeding connection error, will reconnect", { err: (err as Error).message, reconnectMs: RECONNECT_MS });
    } finally {
      await client.disconnect().catch(() => {});
    }
    // Reset per-connection memory on reconnect — ALL of it. The weapon and cap ladders were once
    // missing from this line, which quietly kept half the escalation state across a reconnect the
    // doc above promises is clean.
    escalation = new Map(); weaponEscalation = new Map(); capEscalation = new Map(); capOffense = new Map();
    prevPhase = "idle"; phaseSettled = false; pendingPhase = null; pendingSinceMs = 0; lastTickMs = 0;
    if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
  }
}

/**
 * Auto settings: everything the server does to itself, on one connection.
 *
 * Two features used to live here. "Auto-settings" watched the clock and the population and applied
 * a server-config profile when the active one changed. "Auto-mod" watched the roster and warned,
 * punished or kicked players who broke a rule. They were configured on different screens in
 * different nav sections, and each ran its own loop holding its own RCON connection and polling the
 * same roster on the same cadence — to an operator, one idea described twice.
 *
 * They are one thing now: watch the server, and when a condition holds, act. The condition is a
 * schedule/population window or a player-rule module; the act is a settings write or an enforcement
 * step. One config row, one capability, one loop, and — the reason this is also an efficiency win —
 * ONE roster read per tick feeding both halves instead of two connections reading it separately.
 *
 * Adding a new player rule is still just a module in @app/rules, with no change to this file.
 */
async function autoSettingsServer(repo: Repository, bus: EventBus, server: ServerRow, ctl: RunnerControl): Promise<void> {
  // Off, this switch stops the loop's own work but not the player triggers it watches for (see
  // autoSettingsDuty): the trigger runner fires every other kind of trigger regardless.
  const switchOn = automationEnabled(server.automation, "autosettings");
  const mod = getGame(server.game);
  const descriptor = mod?.descriptor ?? null;
  const fields = new Map((mod?.descriptor.configFields ?? []).map((f) => [f.field, f]));
  const live = server.engagementMode === "active";
  // Per-connection memory, reset on reconnect: the state-rule pacing (when each (rule, player)
  // last fired, so a persisting violation re-fires on the rule's own interval, not every tick)
  // and which settings profile is applied. Resetting pacing on reconnect errs toward one extra
  // warning, never toward a kick nobody was warned about — the enforcer owns the ladder.
  const stateFiredAt = new Map<string, number>();
  let lastApplied: string | null = null;
  // Standing-drift throttle for the enforcement pass: the signature of the last AUDITED drift
  // set, so a value the server clamps (or dry-run findings) report once, not every check.
  let lastEnforceSig = "";
  // When enforcement last ran — it paces itself on AUTOSETTINGS_ENFORCE_MS inside the faster tick.
  let lastEnforceAt = 0;
  // Loop guard for the applyTemplate action: a template whose own profiles immediately apply
  // another template (or each other) would otherwise reconfigure the server every tick, forever.
  // One application per template name per cooldown window, remembered per connection.
  const TEMPLATE_COOLDOWN_MS = 10 * 60_000;
  const templateAppliedAt = new Map<string, number>();
  // Timed match messages already sent, for the match they were loaded for (its start time). Read
  // back from the audit rows when the match changes, so a restart mid-match sends nothing twice.
  // When each roster player was first seen: the roster triggers' "only after N minutes", the kill
  // rate's time base, and the visit in progress that playtime has not recorded yet.
  const rosterFirstSeen = new Map<string, number>();
  // Player triggers on roster conditions: when each one's condition last held (see
  // dueRosterTriggerFirings), kept across reconnects, since a dropped connection is not the
  // condition starting again; and which game account each trigger's player is (a record's game id
  // and game never change, so each is looked up once).
  const rosterTriggerLastTrue = new Map<string, number>();
  const triggerPlayerIds = new Map<string, { platformId: string; game: string }>();
  // Player triggers on a roster condition ("when Bob plays Tank Commander"): the Rules tab's
  // detectors, each for one player of this server's game (@app/rules' player-roster). Read every
  // tick like the rules, so an armed trigger starts watching on the next one.
  const rosterWatchesNow = async () => {
    const armedRoster = (await repo.playerTriggers.listArmed().catch(() => [] as PlayerTriggerRow[]))
      .filter((t) => isPlayerRosterEvent(t.event) && (!t.serverId || t.serverId === server.id));
    const unplaced = [...new Set(armedRoster.map((t) => t.playerId).filter((id) => !triggerPlayerIds.has(id)))];
    if (unplaced.length) {
      for (const pl of await repo.players.findByIds(unplaced).catch(() => [])) triggerPlayerIds.set(pl.id, { platformId: pl.platformId, game: pl.game });
    }
    return rosterTriggerWatchesFor(armedRoster, triggerPlayerIds, server);
  };
  // Team number → side as confident reads established it, for the zone trigger — see
  // enforcementSides — forgotten on a map change, like the seeding runner's.
  const ruleSideMemory = new Map<number, string | null>();
  const ruleSideMap = { mapId: null as string | null };
  // The last status each roster rule wrote (see recordCheck), so an unchanged one is not rewritten
  // every tick.
  const ruleStatusWritten = new Map<string, { sig: string; atMs: number }>();
  // Recorded playtime per playtime-rule shape (see stampPlaytime), shared for a few minutes.
  const playtimeCache = new Map<string, { atMs: number; ids: Set<string>; secs: ReadonlyMap<string, number> }>();
  let matchMsgFor = "";
  let matchMsgSent = new Set<string>();
  // Dry-run's "would send" lines, kept apart so switching dry-run off mid-match still sends.
  let matchMsgWould = new Set<string>();

  while (!ctl.stopped) {
    // Switched off with no roster trigger to watch: no connection, and a look again next tick.
    if (!autoSettingsDuty(switchOn, (await rosterWatchesNow()).length).connect) {
      rosterTriggerLastTrue.clear();
      await ctl.sleep(AUTOSETTINGS_POLL_MS);
      continue;
    }
    const client = gameClientFor(server);
    const slog = log.child({ serverId: server.id, server: server.name });
    try {
      await connectGameClient(client, server);
      while (!ctl.stopped) {
        const rosterWatches = await rosterWatchesNow();
        const duty = autoSettingsDuty(switchOn, rosterWatches.length);
        // Switched off, and the last roster trigger is gone: let the connection go.
        if (!duty.connect) break;
        // Everything else here is the switch's own: off, no profiles, no match messages, no rules.
        const config = duty.own ? await repo.autosettings.getConfig(server.id) : null;
        // The roster-state rules this server answers for (scoping + the game-collision guard live
        // in state-rules.ts, where they are unit-tested). Read every tick — like the enforcer's
        // own 10s refresh — so a rule saved in the panel starts detecting on the next tick, not
        // after a reconnect. Active hours are judged here too: out-of-hours detection is wasted
        // work AND a pacing bug in waiting — the enforcer would drop the event, but the pacing
        // map would still count it as fired.
        const stateRules = duty.own
          ? stateRulesFor(await repo.enforcerRules.list().catch(() => [] as RuleRow[]), server)
            .filter((r) => !r.activeHours || isWindowActive(r.activeHours as ScheduleWindow, new Date()))
          : [];
        const profilesOn = Boolean(config?.enabled) && (config?.profiles.length ?? 0) > 0;
        const matchMessagesOn = Boolean(config?.enabled) && (config?.matchMessages ?? []).some((m) => m.enabled);

        // Nothing configured on either half: drop the per-connection memory and idle. Keeping the
        // connection open is deliberate — enabling a rule should take effect on the next tick, not
        // after a reconnect.
        if (!stateRules.length && !profilesOn && !matchMessagesOn && !rosterWatches.length) {
          stateFiredAt.clear();
          rosterTriggerLastTrue.clear();
          lastApplied = null;
          await ctl.sleep(AUTOSETTINGS_POLL_MS);
          continue;
        }

        // The one read both halves share: the settings half wants the count, the rules half wants
        // the roster. This was two connections each doing this every thirty seconds.
        const raw = await client.readState("players"); // throws if the connection died → reconnect
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as { players?: unknown[] })?.players) ? (raw as { players: unknown[] }).players : [];
        const rosterRaw = list as Record<string, unknown>[];
        const playerCount = rosterRaw.length;
        // Per-side headcounts from the SAME roster read — this is what lets profiles key on
        // "axis short-handed" or "teams lopsided", not just how full the server is.
        const sideSummary = summarizeRoster(rosterRaw as { team?: number | null }[], descriptor);
        const alliedCount = sideSummary.bySide["allies"]?.players ?? null;
        const axisCount = sideSummary.bySide["axis"]?.players ?? null;
        // Minutes into the match — the match the log tracker has open, started at the game's own
        // MATCH START line. Read only when something here asks for it.
        const wantsMatchClock = matchMessagesOn || (profilesOn && (config?.profiles ?? []).some((p) => p.spec?.matchMinutesAtLeast !== undefined || p.spec?.matchMinutesBelow !== undefined))
          || stateRules.some((r) => r.matchMinutesMin > 0 || r.matchMinutesMax > 0 || r.eventKind === KILL_RATE_KIND)
          || rosterWatches.some((w) => w.kind === KILL_RATE_KIND);
        const openMatch = wantsMatchClock ? await repo.matches.getOpen(server.id).catch(() => null) : null;
        const matchMinutes = matchMinutesSince(openMatch?.startedAt, Date.now());

        // ---- profiles: resolve the active one, apply its actions when the match CHANGES ----
        type AutoProfile = {
          name: string; spec?: ScheduleSpec; settings: Record<string, string | number | boolean>;
          nextMap?: string; applyTemplate?: string;
        };
        if (profilesOn && config) {
          // Profiles without their own zone inherit the config's. The stored spec's daysOfWeek is a
          // plain string[]; it matches the scheduler's Weekday[] at runtime (validated on save).
          const profiles = config.profiles.map((p) => (p.spec && !p.spec.timezone ? { ...p, spec: { ...p.spec, timezone: config.timezone } } : p)) as unknown as AutoProfile[];
          const active = resolveProfile(profiles, new Date(), { playerCount, alliedCount, axisCount, matchMinutes });
          const activeName = active?.name ?? null;
          // The EDGE: the active profile changed, so its full settings/actions apply below. Named
          // here because the enforcement pass further down keys off it — enforcement re-reads the
          // server, and on the tick that just wrote everything there is nothing to check yet.
          const settingsEdge = activeName !== lastApplied;
          if (settingsEdge) {
            if (active && Object.keys(active.settings).length > 0) {
              const applied: string[] = [];
              for (const [field, value] of Object.entries(active.settings)) {
                // Game settings go to the server over RCON (gated on live + dry-run); "app:" keys
                // flip the app's OWN automation through the catalog. App switches are our own
                // database, not a game write, so observe mode doesn't block them — each feature
                // still honours its own dry-run/observe posture when it next acts. Dry-run here
                // still means "log, change nothing", for both families alike.
                //
                // "preset:" keys swap a whole feature's behaviour config for a named preset — the
                // full-complexity move, expressed as one line. Behaviour only: a preset never
                // carries the feature's enabled/dry-run switches, so applying one can't arm
                // anything (pair with an "app:" switch when a profile should also turn it on).
                if (field.startsWith("preset:")) {
                  const def = getFeaturePreset(field.slice("preset:".length));
                  if (!def) continue;
                  const preset = await repo.featurePresets.get(def.feature, String(value)).catch(() => null);
                  if (!preset) {
                    slog.warn("auto settings profile names an unknown preset", { profile: active.name, feature: field, preset: String(value) });
                    continue;
                  }
                  // Same guard as the API's apply route (one rule, two doors): a game-scoped
                  // preset from another game would silently enforce the wrong roles/maps here.
                  const mismatch = presetGameMismatch(def, preset.game, server.game);
                  if (mismatch) {
                    slog.warn("auto settings profile names a preset from another game — skipped", { profile: active.name, feature: field, preset: preset.name, presetGame: preset.game, serverGame: server.game });
                    continue;
                  }
                  if (!config.dryRun) await def.apply(repo, server.id, preset.config);
                  applied.push(`${field}=${value}`);
                  continue;
                }
                if (isAppSettingKey(field)) {
                  const app = getAppSetting(field);
                  if (!app) continue;
                  if (!config.dryRun) await app.apply(repo, server.id, value === true);
                  applied.push(`${field}=${value}`);
                  continue;
                }
                const spec = fields.get(field);
                if (!spec?.write) continue;
                // The live welcome message owns the welcome text while it is on; a profile's static
                // text would fight it every change.
                if (field === "welcomeMessage" && (await repo.welcome.getConfig(server.id).catch(() => null))?.enabled) {
                  slog.info("auto settings left the welcome message to the live welcome message", { profile: active.name });
                  continue;
                }
                if (live && !config.dryRun) {
                  // The welcome/notice message carries the signature system's second line when
                  // that is switched on — the same append the Live settings route does, so the
                  // join screen reads the same whichever door set it. Wire-only: the profile and
                  // its audit lines keep the configured text, and being write-only the appended
                  // line can never be mistaken for drift (there is nothing to read back).
                  const wire = field === "welcomeMessage" && typeof value === "string"
                    ? appendWelcomeSignature(await repo.signatures.get(), value) : value;
                  await client.execute(spec.write.command, { [spec.write.param]: wire });
                }
                applied.push(`${field}=${value}`);
              }
              await repo.audit.create({
                actorUserId: null, actorName: "auto settings", action: "autosettings.apply",
                targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
                summary: `Auto settings applied profile "${active.name}" on ${server.name}${live && !config.dryRun ? "" : " (would apply)"}: ${applied.join(", ")}`,
                data: { profile: active.name, applied, playerCount, dryRun: config.dryRun || !live },
              }).catch(() => {});
              slog.info("auto settings applied", { profile: active.name, applied: applied.length, playerCount, dryRun: config.dryRun || !live });
            }

            // Queue a map for when the current match ends. One-shot on the transition, same edge
            // as the settings, so a profile flapping at a boundary cannot spam the rotation.
            if (active?.nextMap) {
              if (live && !config.dryRun) {
                try {
                  const io: RotationIO = {
                    getRotation: async () => stateReaderFor(server.game).rotation(await client.readState("maprotation")),
                    addMapToRotation: async (m, index) => { await client.execute("addMapToRotation", { mapName: m, index }); },
                    removeMapFromRotation: async (index, mapId) => { await client.execute("removeMapFromRotation", { mapName: mapId, index }); },
                  };
                  await scheduleNextMap(io, active.nextMap);
                } catch (e) {
                  slog.warn("auto settings could not queue next map", { profile: active.name, map: active.nextMap, err: (e as Error).message });
                }
              }
              await repo.audit.create({
                actorUserId: null, actorName: "auto settings", action: "autosettings.nextmap",
                targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
                summary: `Auto settings profile "${active.name}"${live && !config.dryRun ? " queued" : " would queue"} ${active.nextMap} as next map on ${server.name}`,
                data: { profile: active.name, map: active.nextMap, dryRun: config.dryRun || !live },
              }).catch(() => {});
            }

            // Auto settings reconfiguring itself: replace this server's behaviour (profiles,
            // timezone) from a saved template. Never touches enabled/dry-run, so a
            // template cannot silently arm enforcement. The cooldown breaks apply loops; every
            // application (or refusal) is audited so a misbehaving chain is visible, not mystifying.
            if (active?.applyTemplate) {
              const tplName = active.applyTemplate;
              const lastAt = templateAppliedAt.get(tplName.toLowerCase()) ?? 0;
              if (Date.now() - lastAt < TEMPLATE_COOLDOWN_MS) {
                slog.warn("auto settings template apply skipped (cooldown)", { profile: active.name, template: tplName });
              } else {
                const tpl = await repo.autosettings.templates.get(tplName).catch(() => null);
                if (!tpl) {
                  slog.warn("auto settings profile names an unknown template", { profile: active.name, template: tplName });
                } else {
                  templateAppliedAt.set(tplName.toLowerCase(), Date.now());
                  // Profiles and timezone only: the player-rule scenarios live on enforcer rules
                  // now, and an old template's module blob must not resurrect retired machinery.
                  const applied = { timezone: tpl.config.timezone, profiles: tpl.config.profiles };
                  // What it replaces, copied before the write, so the trail can say what changed.
                  const was = await repo.autosettings.getConfig(server.id).catch(() => null);
                  const before = JSON.parse(JSON.stringify({ timezone: was?.timezone ?? config.timezone, profiles: was?.profiles ?? [] })) as typeof applied;
                  await repo.autosettings.upsertConfig(server.id, applied);
                  await repo.audit.create({
                    actorUserId: null, actorName: "auto settings", action: "autosettings.template",
                    targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
                    summary: `Auto settings profile "${active.name}" applied template "${tpl.name}" to ${server.name}`,
                    data: { profile: active.name, template: tpl.name, profiles: tpl.config.profiles.length, before, after: applied },
                  }).catch(() => {});
                  slog.info("auto settings template applied", { profile: active.name, template: tpl.name });
                }
              }
            }
            lastApplied = activeName;
            lastEnforceSig = ""; // new desires — any standing drift finding is stale
            lastEnforceAt = Date.now(); // the edge wrote everything; start the clock from here
          }

          /*
           * ---- settings enforcement: hold the profile, not just its edge ----
           *
           * The edge above fires once, when the ACTIVE PROFILE changes. The server offers no such
           * courtesy in return: a patch or a restore resets its settings to defaults, the profile
           * name has not changed, and the runner never spoke again — the operator re-entered
           * their base settings by hand and rightly asked what the automation was for. So while a
           * profile with settings is active, every tick re-reads the READABLE fields it sets and
           * rewrites exactly the ones that drifted.
           *
           * Write-only fields (welcome message, VIP slots) stay edge-only: drift on a value we
           * cannot read is not knowable, and rewriting blind every tick is noise. A field the
           * server refuses to answer is skipped the same way — "couldn't read" is never
           * "drifted", the same evidence rule as the reconcilers. Combined with an unconditional
           * profile (no schedule = always active), this is the standing "base settings" keeper.
           */
          if (active && !settingsEdge && Object.keys(active.settings).length > 0 && Date.now() - lastEnforceAt >= AUTOSETTINGS_ENFORCE_MS) {
            lastEnforceAt = Date.now();
            const current: Record<string, unknown> = {};
            for (const field of Object.keys(active.settings)) {
              if (field.startsWith("preset:") || isAppSettingKey(field)) continue; // app-side keys: nothing to read off the game
              const spec = fields.get(field);
              if (!spec?.read) continue;
              try {
                const v = extractSettingValue(await client.execute(spec.read.command), spec.read.key);
                if (v !== undefined) current[field] = v;
              } catch { /* unsupported on this protocol/build — not drift */ }
            }
            const drift = settingsDrift(fields, active.settings as Record<string, string | number | boolean>, current);
            if (!drift.length) {
              lastEnforceSig = "";
            } else {
              // Readable drift is the wipe detector for the fields that have no getter at all
              // (VIP slots, max queue, welcome message): if the server forgot what we CAN see,
              // it forgot what we cannot, so those are re-taught in the same pass. They are never
              // rewritten outside a detected wipe — blind writes every check would be noise.
              const blind = writeOnlySettings(fields, active.settings as Record<string, string | number | boolean>);
              if (live && !config.dryRun) {
                for (const d of drift) {
                  const spec = fields.get(d.field)!;
                  try { await client.execute(spec.write!.command, { [spec.write!.param]: d.want }); }
                  catch (e) { slog.warn("auto settings could not re-apply a drifted setting", { field: d.field, err: (e as Error).message }); }
                }
                const liveWelcome = (await repo.welcome.getConfig(server.id).catch(() => null))?.enabled === true;
                for (const b of blind) {
                  const spec = fields.get(b.field)!;
                  // A wiped server while the live welcome is on: have IT rewrite (it holds the
                  // real text), rather than re-teaching the profile's static one.
                  if (b.field === "welcomeMessage" && liveWelcome) {
                    await repo.welcome.markWritten(server.id, null, null).catch(() => {});
                    continue;
                  }
                  // Same second-line append as the apply edge — a wipe recovery must re-teach the
                  // join screen exactly what it said before the wipe, second line included.
                  const wire = b.field === "welcomeMessage" && typeof b.want === "string"
                    ? appendWelcomeSignature(await repo.signatures.get(), b.want) : b.want;
                  try { await client.execute(spec.write!.command, { [spec.write!.param]: wire }); }
                  catch (e) { slog.warn("auto settings could not re-apply a write-only setting", { field: b.field, err: (e as Error).message }); }
                }
              }
              // One audit entry per STANDING situation: a successful rewrite clears the drift by
              // the next tick (new wipe = new entry), while a value the server clamps — or any
              // drift under dry-run — would otherwise repeat every thirty seconds forever.
              const sig = driftSignature(drift);
              if (sig !== lastEnforceSig) {
                lastEnforceSig = sig;
                await repo.audit.create({
                  actorUserId: null, actorName: "auto settings", action: "autosettings.enforce",
                  targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
                  summary: `Auto settings ${live && !config.dryRun ? "re-applied" : "would re-apply"} ${drift.length} drifted setting(s) from profile "${active.name}" on ${server.name}: ${drift.map((d) => `${d.field} ${String(d.have)}→${String(d.want)}`).join(", ")}${blind.length ? ` (+${blind.length} write-only re-taught: ${blind.map((b) => b.field).join(", ")})` : ""}`,
                  data: { profile: active.name, drift, blind, dryRun: config.dryRun || !live },
                }).catch(() => {});
              }
              slog.info("auto settings drift", { profile: active.name, drifted: drift.map((d) => d.field), dryRun: config.dryRun || !live });
            }
          }
        }

        // ---- timed match messages: "N minutes after the match starts, tell everyone X" ----
        // Separate from the profiles on purpose: a message is not a state the server is in, and a
        // profile made of one would take the server away from whichever profile should own it.
        if (matchMessagesOn && config && openMatch?.startedAt) {
          if (matchMsgFor !== openMatch.startedAt) {
            matchMsgFor = openMatch.startedAt;
            const rows = await repo.audit.list({ actions: ["autosettings.message"], serverId: server.id, from: openMatch.startedAt, limit: 200 }).catch(() => []);
            matchMsgSent = sentMatchMessageKeys(rows);
            matchMsgWould = sentMatchMessageKeys(rows, true);
          }
          const send = live && !config.dryRun;
          const sentSet = send ? matchMsgSent : matchMsgWould;
          const due = dueMatchMessages({ messages: config.matchMessages, matchStartedAt: openMatch.startedAt, matchMinutes, playerCount, sent: sentSet });
          for (const { message: m, key } of due) {
            sentSet.add(key); // before sending: a send that dies half way is not repeated
            let reached = "";
            if (send) {
              try {
                const rr = rendererFor(repo, server, client);
                const out = await messageEveryone(client, hasPlaceholders(m.message) ? (pl) => rr.render(m.message, pl) : m.message, {
                  onError: (playerId, err) => slog.debug("timed match message did not reach one player", { playerId, err: err.message }),
                });
                // Every send failed (the connection died after the roster read): nobody saw it.
                if (out.sent === 0 && out.failed > 0) throw new Error(`all ${out.failed} sends failed`);
                reached = ` to ${out.sent} player(s)`;
              } catch (err) {
                // Only when NOBODY was reached (the roster read died, or every send did — a few
                // players missing it is counted, not thrown), so nothing went out: try again on the next check,
                // which is still inside the message's grace minutes. Not written to the record
                // here, so a restart does not mistake it for sent.
                sentSet.delete(key);
                slog.warn("a timed match message did not reach players — retrying on the next check", { minutes: m.minutes, err: (err as Error).message });
                continue;
              }
            }
            await repo.audit.create({
              actorUserId: null, actorName: "auto settings", action: "autosettings.message",
              targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
              summary: `Auto settings ${send ? "sent" : "would send"} the ${m.minutes}-minute match message on ${server.name}${reached}: ${m.message.slice(0, 120)}`,
              data: { key, minutes: m.minutes, matchMinutes: matchMinutes === null ? null : Math.floor(matchMinutes), playerCount, dryRun: !send },
            }).catch(() => {});
          }
        }

        // ---- roster-state rules ----
        // The player-rule scenarios (solo tank/helicopter, no squad leader, level, role, name) are
        // Rules-engine triggers now — Rules is the one place server rule customization comes from.
        // This runner owns only what it alone can see, the live roster: it runs each state rule's
        // detector with THAT rule's params and emits one synthetic bus event per offending player,
        // carrying the rule's id. The enforcer fires it like any event — immunity, escalation,
        // dry-run, per-rule alerts and audit all live there, in one place instead of two.
        if (stateRules.length || rosterWatches.length) {
          let players = rosterRaw.map((pl) => rosterToRulePlayer(pl, mod));
          const nowMs = Date.now();
          // A player trigger judges only its own player: one who isn't on this roster has nothing
          // to check, and asks for none of the reads below.
          const present = new Set(players.map((p) => p.playerId));
          const watching = rosterWatches.filter((w) => present.has(w.platformId));
          // The no-VIP trigger needs to know who HOLDS VIP — our grants and the game's own list —
          // read only when such a rule (or player trigger) is on, so every other install pays
          // nothing. An unreadable game list leaves everyone's VIP unknown, and the trigger then
          // flags nobody.
          const kinds = new Set([...stateRules.map((r) => r.eventKind), ...watching.map((w) => w.kind)]);
          // Time on the server — the "only after N minutes" knobs, the kill rate's time base and
          // the visit in progress for playtime — from this runner's own memory of first sight.
          if (kinds.has(NO_VIP_KIND) || kinds.has(NO_DISCORD_KIND) || kinds.has(KILL_RATE_KIND) || kinds.has(PLAYTIME_KIND)) {
            players = stampOnline(players, rosterFirstSeen, nowMs);
          } else {
            rosterFirstSeen.clear();
          }
          if (kinds.has(NO_VIP_KIND)) {
            const grants = await repo.vips.list(server.id).catch(() => null);
            let gameVipIds: Set<string> | null = null;
            try {
              const listed = normalizeGameVips(await client.execute("getVipIds"));
              gameVipIds = listed ? new Set(listed.map((v) => v.playerId)) : null;
            } catch { gameVipIds = null; }
            players = annotateVip(players, { grants: grants ?? [], gameVipIds: grants ? gameVipIds : null, firstSeenMs: rosterFirstSeen, nowMs });
          }
          if (kinds.has(KILL_RATE_KIND)) players = stampPlayMinutes(players, matchMinutes);
          // Discord links and playtime are keyed by PROFILE id: one batched lookup maps the roster.
          // A failed lookup leaves both unknown, and their triggers flag nobody.
          if (kinds.has(NO_DISCORD_KIND) || kinds.has(PLAYTIME_KIND)) {
            const rows = await repo.players.findByPlatformIds(players.map((p) => p.playerId)).catch(() => null);
            const profileOf = new Map((rows ?? []).filter((r) => r.game === server.game).map((r) => [r.platformId, r.id]));
            const ids = [...profileOf.values()];
            if (kinds.has(NO_DISCORD_KIND)) {
              const linked = rows ? await repo.externalLinks.linkedAmong(ids, "discord").catch(() => null) : null;
              players = stampDiscord(players, profileOf, linked);
            }
            if (kinds.has(PLAYTIME_KIND)) {
              const secondsByKey = new Map<string, ReadonlyMap<string, number>>();
              // Every playtime shape asked for, by a rule or a player trigger.
              const shapes = [
                ...stateRules.filter((x) => x.eventKind === PLAYTIME_KIND).map((x) => resolveTriggerParams(PLAYTIME_KIND, x.params)),
                ...watching.filter((w) => w.kind === PLAYTIME_KIND).map((w) => w.params),
              ];
              for (const prm of shapes) {
                const allServers = prm.allServers === true;
                const periodDays = Math.max(0, Number(prm.periodDays ?? 0));
                const key = playtimeKey(allServers, periodDays);
                if (secondsByKey.has(key)) continue;
                // Recorded playtime moves only when a visit ends, so one read serves a few minutes;
                // a roster that gained someone reads again rather than miss them.
                const hit = playtimeCache.get(key);
                if (hit && nowMs - hit.atMs < PLAYTIME_CACHE_MS && ids.every((id) => hit.ids.has(id))) { secondsByKey.set(key, hit.secs); continue; }
                const secs = await repo.stats.playtimeFor(ids, {
                  serverId: allServers ? null : server.id,
                  since: periodDays > 0 ? new Date(nowMs - periodDays * 86_400_000).toISOString() : null,
                }).catch(() => null);
                if (!secs) continue;
                playtimeCache.set(key, { atMs: nowMs, ids: new Set(ids), secs });
                secondsByKey.set(key, secs);
              }
              players = stampPlaytime(players, profileOf, secondsByKey);
            }
          }
          // The zone trigger needs two things the roster alone cannot give: which MAP is live
          // (zones are painted per map) and which SIDE each raw team number is (they are painted
          // per side). Both are read only when a zone rule is actually enabled — the same gate
          // the seeding runner puts on its session read — so every other install pays nothing.
          // Keyed by the rule's id, or a zone player trigger's: each names its own painted set.
          let zonesByRuleId: Map<string, ZoneCellSets | null> | undefined;
          let sideOfTeamFn: ((team: number) => string | null) | undefined;
          const zoneRules = [
            ...stateRules.filter((r) => r.eventKind === OUT_OF_ZONE_KIND).map((r) => ({ id: r.id, zoneSet: resolveTriggerParams(r.eventKind, r.params).zoneSet })),
            ...watching.filter((w) => w.kind === OUT_OF_ZONE_KIND).map((w) => ({ id: w.trigger.id, zoneSet: w.params.zoneSet })),
          ];
          if (zoneRules.length) {
            const zs = normalizeSession(await client.readState("session").catch(() => null));
            const zoneKey = zoneKeyOf(zs.mapId ?? zs.mapName ?? null);
            const teamCounts = new Map<number, number>();
            for (const pl of rosterRaw) {
              const t = Number(pl?.team ?? 0);
              teamCounts.set(t, (teamCounts.get(t) ?? 0) + 1);
            }
            // Only a confident read places a team (see enforcementSides): with even teams the
            // resolver falls back to a guess that can come out backwards, and this trigger acts on
            // the side — a backwards guess reads a player's own zone as the enemy's.
            const zSides = descriptor?.sides ?? [];
            forgetSidesOnNewMap(ruleSideMemory, ruleSideMap, zs.mapId ?? zs.mapName ?? null);
            const sideMap = enforcementSides(resolveTeamSides(zSides, teamCounts, zs), teamSidesConfident(zSides, teamCounts, zs), ruleSideMemory);
            sideOfTeamFn = (t) => sideMap.get(t) ?? null;
            zonesByRuleId = new Map();
            const setCache = new Map<string, Awaited<ReturnType<typeof repo.mapZones.get>>>();
            for (const r of zoneRules) {
              const setId = String(r.zoneSet ?? "");
              let set = setCache.get(setId);
              if (set === undefined) {
                set = await repo.mapZones.get(setId).catch(() => null);
                setCache.set(setId, set);
              }
              // A set for ANOTHER game paints nothing here — its cell lists describe maps this
              // server never plays, and enforcing them would be the cross-game misread the
              // state-rules scoping exists to prevent.
              const paint = set && set.game === server.game && zoneKey ? set.zones[zoneKey] : null;
              zonesByRuleId.set(r.id, paint
                ? { allies: new Set(paint.allies ?? []), axis: new Set(paint.axis ?? []), shared: new Set(paint.shared ?? []) }
                : null);
            }
          }
          // The clan tag trigger groups spellings the way Players → Clans does — staff's combines
          // and splits included — read only while such a rule is on. Unreadable = no grouping, and
          // the trigger flags nobody rather than match spellings staff split apart.
          let clans: { ofTag(tag: string): string; ofKey(key: string): string } | null = null;
          if (kinds.has(CLAN_TAG_KIND)) {
            const settings = (await repo.appConfig.get().catch(() => null))?.clanTags ?? null;
            if (settings) clans = { ofTag: (t) => clanGroupOf(settings, t), ofKey: (k) => clanResolveKey(settings, k) };
          }
          // Every decision (bounds, pacing, detection) is state-rules.ts's; only the I/O is ours.
          const report = new Map<string, StateRuleReport>();
          const due = dueStateFirings({ rules: stateRules, players, playerCount, descriptor, firedAt: stateFiredAt, nowMs, zonesByRuleId, sideOfTeam: sideOfTeamFn, matchMinutes, clans, report });
          const sentByRule = new Map<string, number>();
          const unknownByRule = new Map<string, number>();
          if (due.length) {
            /*
             * TWO ID SPACES MEET HERE. The roster speaks the GAME's platform id; bus events key
             * players by our INTERNAL id (ingest resolves before storing, and the enforcer
             * resolves back to the platform id for its RCON command). One batched lookup
             * translates; a player our directory has never seen is dropped rather than emitted
             * under an id the enforcer could not resolve — they will still be on the roster next
             * interval, by which time ingest has recorded them.
             */
            const rows = await repo.players.findByPlatformIds([...new Set(due.map((d) => d.playerId))]).catch(() => []);
            // This server's game only: the same platform id can key a row in each game.
            const internalByPlatform = new Map(rows.filter((pl) => pl.game === server.game).map((pl) => [pl.platformId, pl.id]));
            for (const d of due) {
              const actorPlayerId = internalByPlatform.get(d.playerId);
              if (!actorPlayerId) {
                // Not recorded yet: forget the pacing stamp so the NEXT check retries, rather than
                // one re-check interval (half an hour, on a VIP rule) from now.
                stateFiredAt.delete(`${d.rule.id}|${d.playerId}`);
                unknownByRule.set(d.rule.id, (unknownByRule.get(d.rule.id) ?? 0) + 1);
                continue;
              }
              sentByRule.set(d.rule.id, (sentByRule.get(d.rule.id) ?? 0) + 1);
              bus.emit(d.rule.eventKind, {
                kind: d.rule.eventKind, serverId: server.id, actorPlayerId, actorName: d.name,
                ts: new Date().toISOString(), data: { ruleId: d.rule.id, violation: d.reason },
              });
            }
            slog.debug("state rules detected", { rules: stateRules.length, fired: due.length });
          }
          // What each rule saw, for its card — written when it changes, and at least once a minute
          // so "checked 20s ago" stays true while nothing does.
          for (const rule of stateRules) {
            const rep = report.get(rule.id);
            if (!rep) continue;
            const summary = {
              roster: players.length, flagged: rep.flagged, sent: sentByRule.get(rule.id) ?? 0,
              paced: rep.flagged - rep.due, unknownPlayers: unknownByRule.get(rule.id) ?? 0,
              held: rep.held, breakdown: rep.breakdown,
            };
            const sig = JSON.stringify(summary);
            const last = ruleStatusWritten.get(rule.id);
            if (last && last.sig === sig && nowMs - last.atMs < 60_000) continue;
            ruleStatusWritten.set(rule.id, { sig, atMs: nowMs });
            await repo.enforcerRules.recordCheck(rule.id, server.id, summary).catch(() => {});
          }
          if (stateRules.length) pruneStateFiredAt(stateFiredAt, nowMs);
          else stateFiredAt.clear();

          // The player triggers on roster conditions: each fires when its condition STARTS, for
          // the one player it is about (see dueRosterTriggerFirings). Its player is a record of
          // ours already, so the event carries that id with no translation; the API's trigger
          // runner fires the trigger it names.
          if (watching.length) {
            const firings = dueRosterTriggerFirings({ watches: watching, players, descriptor, lastTrue: rosterTriggerLastTrue, nowMs, zonesById: zonesByRuleId, sideOfTeam: sideOfTeamFn, clans });
            for (const f of firings) {
              bus.emit(PLAYER_TRIGGER_ROSTER_KIND, {
                kind: PLAYER_TRIGGER_ROSTER_KIND, serverId: server.id, actorPlayerId: f.trigger.playerId, actorName: f.name,
                ts: new Date().toISOString(), data: { triggerId: f.trigger.id, event: f.event, violation: f.reason },
              });
            }
            if (firings.length) slog.debug("player triggers on roster conditions", { watching: watching.length, fired: firings.length });
          }
          pruneRosterTriggerMemory(rosterTriggerLastTrue, nowMs);
        } else {
          stateFiredAt.clear();
        }

        await ctl.sleep(AUTOSETTINGS_POLL_MS);
      }
    } catch (err) {
      slog.error("auto settings connection error, will reconnect", { err: (err as Error).message, reconnectMs: RECONNECT_MS });
    } finally {
      await client.disconnect().catch(() => {});
    }
    stateFiredAt.clear(); // reset per-connection memory on reconnect
    lastApplied = null;
    if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
  }
}

/**
 * Sample the server's SHAPE — how many, split how, in which roles, which squads leaderless — and
 * store it.
 *
 * This exists because none of it can be recovered later. The admin log records what people DID; it
 * never records what they were playing, so "were we short of officers last Saturday" has no answer
 * unless somebody was writing it down at the time. This is that.
 *
 * It rides the ingest connection rather than opening its own: ingest already holds a live socket to
 * every server and polls it continuously, so the marginal cost is two reads a minute instead of a
 * whole extra connection per server.
 *
 * Never throws. A snapshot is a nice-to-have; losing one is a gap in a chart, whereas letting it
 * bubble would tear down the log ingestion this rides on, which is not.
 */
/**
 * @param lastObservedAt the previous successful roster observation of this server in THIS process,
 *   or null on the first one — in which case the store's newest snapshot seeds it, so a restart
 *   after an outage still knows when the server was last seen.
 * @returns the timestamp to pass back next tick.
 */
/** Last "roster entries with no usable id" warning per server — a whole platform going invisible
 *  deserves a warn, but one per tick would be a hundred lines an hour. */
const identityGapWarnedAt = new Map<string, number>();
const IDENTITY_GAP_REPEAT_MS = 15 * 60_000;

async function snapshotRoster(
  repo: Repository,
  server: ServerRow,
  client: { readState: (kind: "players" | "session") => Promise<unknown> },
  slog: Logger,
  lastObservedAt: string | null = null,
): Promise<string | null> {
  const observedBefore = lastObservedAt
    ?? (await repo.rosterSnapshots.latest(server.id).catch(() => null))?.ts
    ?? null;
  let observedNow: string | null = lastObservedAt;
  try {
    // The session read is not optional decoration: its headcounts are what let side resolution
    // recover from a server build whose team encoding puts both teams on one side. Without it a
    // snapshot can record a 40-nil server that was really 20v20.
    const [rawPlayers, rawSession] = await Promise.all([
      client.readState("players"),
      client.readState("session").catch(() => null),
    ]);
    const list = Array.isArray(rawPlayers) ? rawPlayers
      : Array.isArray((rawPlayers as { players?: unknown[] })?.players) ? (rawPlayers as { players: unknown[] }).players
      : [];
    // Identity capture (names + clan tags → the profile's alias history) used to happen ONLY on
    // the API's /live read — meaning only while a staff member had the Live view open. Whenever
    // nobody was watching, nothing accrued, and profiles quietly stopped gaining clan history.
    // This read already carries both fields; recording them here makes the history continuous.
    // Best-effort on its own: a failed capture must not cost the snapshot or the stats fold.
    const seenAt = new Date().toISOString();
    // Identity through the game module (playerIdentityOf), same as the API's /live read: which
    // field is the durable id is the game's call, and this must agree with it or the snapshot
    // path would fork the very players the live path just kept whole.
    await (async () => {
      const withWho = (list as Record<string, unknown>[])
        .map((p) => ({ p, who: playerIdentityOf(getGame(server.game), p) }))
        .filter((x): x is typeof x & { who: NonNullable<typeof x.who> } => !!x.who);
      // Entries the identity rule could not key are PEOPLE THE APP CANNOT SEE: no player row, no
      // session, no kills, no analytics — a whole platform's population goes missing the day the
      // game changes a field. Silence here is how the field found out via a stats page. Warn with
      // the platform tokens and the entry's field NAMES (never values — that is what fixing the
      // identity rule needs), throttled per server.
      if (withWho.length < (list as unknown[]).length) {
        const last = identityGapWarnedAt.get(server.id) ?? 0;
        if (Date.now() - last >= IDENTITY_GAP_REPEAT_MS) {
          identityGapWarnedAt.set(server.id, Date.now());
          const missing = (list as Record<string, unknown>[]).filter((p) => !playerIdentityOf(getGame(server.game), p));
          const platforms = new Map<string, number>();
          for (const p of missing) {
            const key = String(p?.platform ?? "(no platform field)");
            platforms.set(key, (platforms.get(key) ?? 0) + 1);
          }
          slog.warn("roster entries with no usable player id — invisible to stats, sessions and VIP", {
            count: missing.length, of: (list as unknown[]).length,
            platforms: Object.fromEntries(platforms),
            fields: Object.keys(missing[0] ?? {}).sort(),
          });
        }
      }
      const rows = await repo.players.upsertMany(withWho.map(({ p, who }) => ({
        game: server.game,
        platform: who.platform,
        platformId: who.platformId,
        name: String(p?.name ?? ""),
        clanTag: p?.clanTag !== undefined ? String(p.clanTag) : undefined,
        // The always-on observer: the worker samples every server on a timer, so this is what
        // keeps levels current for players the panel never happens to have open.
        level: Number.isFinite(Number(p?.level)) ? Number(p.level) : undefined,
        ts: seenAt,
      })));
      // Identity links the module reports beside the durable id (Vietnam carries each Steam
      // player's Steam64 this way) are persisted from HERE, not only from the API's /live read —
      // the worker is the observer that is always on, and these links are what will let a
      // person's Vietnam account be joined to their WW2 one.
      const idByPlatform = new Map(rows.map((r) => [r.platformId, r.id]));
      await Promise.all(withWho
        .flatMap(({ who }) => (who.links ?? []).map((link) => ({ id: idByPlatform.get(who.platformId), link })))
        .map(({ id, link }) => (id ? repo.externalLinks.set(id, link.provider, link.externalId) : undefined)));
      /*
       * Reap sessions this roster no longer backs — the fix for "perma-banned an hour ago and
       * still shows ONLINE". A session only closes on a parsed DISCONNECTED line, and the game
       * does not always provide one: a ban-kick's log line names the player without an id, a
       * server crash logs nothing at all, and a worker restart misses whatever happened while it
       * was down. Any of those stranded the open-session row FOREVER, and everything reading
       * "online now" (the profile badge, the watchlist, payout presence) kept saying the player
       * was here. This roster read is the ground truth that they are not.
       *
       * The grace covers the two honest races: a player who connected after this roster read
       * left the wire, and a roster row whose identity could not be parsed this tick. Sits inside
       * the identity IIFE deliberately — if resolution failed, `rows` is not the roster, and a
       * reap against a partial present-list would close sessions of people still playing.
       */
      // Only when the WHOLE roster resolved: a tick where some identities failed to parse has a
      // present-list that is missing real people, and reaping against it would log them out while
      // they play. An empty roster passes (0 of 0) — an empty server is exactly the case after a
      // crash stranded the whole lobby.
      if (withWho.length === (list as unknown[]).length) {
        const reapCutoff = new Date(Date.now() - SESSION_REAP_GRACE_MS).toISOString();
        const endAt = reapEndAt(seenAt, observedBefore);
        const reaped = await repo.sessions.closeAbsent(server.id, rows.map((r) => r.id), reapCutoff, endAt);
        if (reaped > 0) slog.info("closed stale sessions the live roster no longer backs", { count: reaped, endAt });
      }
    })().catch(() => {});
    const players = (list as Record<string, unknown>[]).map((p) => ({
      team: p?.team == null ? null : Number(p.team),
      role: p?.role == null ? null : Number(p.role),
      platoon: p?.platoon == null ? null : String(p.platoon),
    }));
    // Through the session normalizer, not read raw: the raw keys are protocol-specific (binary-v2
    // happens to say `alliedPlayerCount`, the CRCON bridge says `num_allied_players`), and the
    // headcount correction below is exactly the thing that keeps a snapshot from recording a
    // 40-nil server that was really 20v20. Reading raw only ever worked for v2.
    const session = rawSession == null ? null : normalizeSession(rawSession);
    const composition = summarizeRoster(players, getGame(server.game)?.descriptor ?? null, session as SessionHeadcounts | null);

    await repo.rosterSnapshots.record({
      serverId: server.id,
      // Truncated to the second: the unique index is on the instant, and sub-second precision would
      // let a retry a few milliseconds later write a second row for the same sample.
      ts: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      playerCount: players.length,
      composition,
      mapName: session?.mapName ?? null,
      gameMode: session?.gameMode ?? null,
      // The same session read the composition came from. One sample per minute of {ts, score} is
      // the score timeline the public API serves as CRCON's `cap_flips`; nothing else needs to run.
      alliedScore: session?.alliedScore ?? null,
      axisScore: session?.axisScore ?? null,
      // Who was waiting to get in, off the same read — each counter only where it can be a queue.
      queueCount: session ? queueDepth(session) ?? null : null,
      vipQueueCount: session ? vipQueueDepth(session) ?? null : null,
    });
    // The same read carries the live score. Stamp it on the open round every tick, because the
    // MATCH ENDED log line is not a reliable source of one — HLL: Vietnam's carries no score at
    // all, which left every finished round reading "unknown" with no winner. The last sample
    // before the whistle is the final score, and `close` will not overwrite it with a null.
    if (typeof session?.alliedScore === "number" && typeof session?.axisScore === "number") {
      // Conquest rides the same sample: a POSITIVE initialMorale is what says this round is
      // scored in morale — every other mode reports zeros there, and recording those would
      // stamp a 0-0 "finished drain" onto a warfare round. Sampled-not-erased, like the score.
      const morale = (session.initialMorale ?? 0) > 0
        ? { initialMorale: session.initialMorale, alliedMorale: session.alliedMorale ?? 0, axisMorale: session.axisMorale ?? 0 }
        : {};
      await repo.matches.recordScore(server.id, { alliedScore: session.alliedScore, axisScore: session.axisScore, ...morale })
        .catch((err) => slog.debug("score sample skipped", { err: (err as Error).message }));
    }
    // The same read already in hand also carries every per-player figure the game keeps: the score
    // buckets, vehicle kills, level and the role they are playing right now. Composition only needs
    // counts, so all of that used to be discarded here — which is why a Hell Let Loose player who
    // builds nodes and holds a point had nothing on their profile but kills and deaths.
    await foldRosterStats(repo, server, list as Record<string, unknown>[], slog);

    slog.debug("roster snapshot", { players: players.length });
    // Only a read that got this far counts as an observation: a tick that threw saw nothing, and
    // letting it move the mark would credit a stranded session for time nobody was watching.
    observedNow = seenAt;
    const back = quiet.ok(`roster-snapshot:${server.id}`);
    if (back.recovered) slog.info("roster snapshots are being taken again", { afterAttempts: back.runs, wasBroken: forDuration(back.sinceMs) });
  } catch (err) {
    // Composition history is only ever written here — nothing recovers a sample that was not taken.
    const v = quiet.fail(`roster-snapshot:${server.id}`);
    if (v.speak) slog.warn("roster snapshots are failing — player-count and composition history has a hole in it while this lasts", { server: server.name, attempts: v.runs, failing: forDuration(v.sinceMs), err: (err as Error).message });
    else slog.debug("roster snapshot skipped", { err: (err as Error).message });
  }
  return observedNow;
}

/**
 * Redraw the server's live match board in Discord.
 *
 * ONE message per server, edited in place forever. The message id lives in the relay config and is
 * written back after the first post, so a worker restart picks the same message back up. Nothing
 * here posts a second message unless Discord itself says the first one is gone — a channel that
 * accumulates round summaries is worse than no channel, because the top of it is always a lie.
 *
 * Rides the ingest connection: the reads it needs (roster + session) are the reads that loop is
 * already making, so a board costs no extra connection.
 *
 * Returns whether the caller should restart the board's timer. `false` means only "not yet, under a
 * longer configured interval" — everything else, including a failed read, settles the cycle so a
 * sick server can't turn into a Discord hammer.
 */
async function drawStatusBoard(
  repo: Repository,
  server: ServerRow,
  client: { readState: (kind: "players" | "session" | "maprotation") => Promise<unknown> },
  slog: Logger,
  elapsedMs: number,
): Promise<boolean> {
  if (!discordToken()) return true;
  const cfg = await repo.discordRelay.getConfig(server.id);
  const board = cfg?.statusBoard;
  if (!board?.enabled || !board.channelId) return true;
  const channelId = board.channelId;
  if (elapsedMs < Math.max(DISCORD_STATUS_BOARD_MIN_SEC, board.intervalSec) * 1000) return false;

  try {
    const [rawPlayers, rawSession, rawRotation] = await Promise.all([
      client.readState("players"),
      client.readState("session"),
      client.readState("maprotation").catch(() => null), // not every protocol exposes it
    ]);
    const roster = (Array.isArray(rawPlayers) ? rawPlayers
      : Array.isArray((rawPlayers as { players?: unknown[] })?.players) ? (rawPlayers as { players: unknown[] }).players
      : []) as Record<string, unknown>[];
    // The same normalizer the panel's match card reads through, so the two never disagree about
    // what a number means (binary v2 mangles acronyms: `VIPQueueCount` arrives as `vIPQueueCount`).
    const session = normalizeSession(rawSession);

    // Which raw team number is which faction is decided the same way the live view decides it —
    // with the session's own headcounts as evidence, not the static descriptor guess alone.
    const sides = getGame(server.game)?.descriptor.sides ?? [];
    const teamCounts = new Map<number, number>();
    for (const pl of roster) {
      const t = Number(pl?.team);
      if (Number.isFinite(t)) teamCounts.set(t, (teamCounts.get(t) ?? 0) + 1);
    }
    const sideByTeam = resolveTeamSides(sides, teamCounts, session);

    // Per-side totals AND the standouts, in one pass over the roster. The score buckets come from
    // the game descriptor rather than hardcoded keys — HLL's combat bucket arrives as `cOMBAT`.
    const scoreKeys = getGame(server.game)?.descriptor.scoreFields.map((f) => f.key) ?? [];
    const [kCombat, kOffense, kDefense, kSupport] = scoreKeys;
    const totals: Record<string, SideTotals> = {};
    for (const side of sides) totals[side.id] = { ...EMPTY_TOTALS };
    const best: Record<string, { name: string; value: number; sideId: string | null }> = {};
    const consider = (metric: string, name: string, value: number, sideId: string | null) => {
      if (value <= 0 || !name) return;
      if (!best[metric] || value > best[metric]!.value) best[metric] = { name, value, sideId };
    };
    for (const pl of roster) {
      const sideId = sideByTeam.get(Number(pl?.team)) ?? null;
      const st = (pl?.stats ?? {}) as { infantryKills?: number; vehicleKills?: number; deaths?: number };
      const sd = (pl?.scoreData ?? {}) as Record<string, number>;
      const num = (k?: string) => (k ? Number(sd[k]) || 0 : 0);
      const kills = (Number(st.infantryKills) || 0) + (Number(st.vehicleKills) || 0);
      const name = String(pl?.name ?? "").trim();
      const t = sideId ? totals[sideId] : undefined;
      if (t) {
        t.players += 1;
        t.kills += kills;
        t.deaths += Number(st.deaths) || 0;
        t.combat += num(kCombat);
        t.offense += num(kOffense);
        t.defense += num(kDefense);
        t.support += num(kSupport);
      }
      consider("kills", name, kills, sideId);
      consider("combat", name, num(kCombat), sideId);
      consider("offense", name, num(kOffense), sideId);
      consider("defense", name, num(kDefense), sideId);
      consider("support", name, num(kSupport), sideId);
    }
    const leaders: Leader[] = ([
      ["kills", "MOST KILLS"], ["combat", "HIGHEST COMBAT"], ["offense", "HIGHEST OFFENSE"],
      ["defense", "HIGHEST DEFENSE"], ["support", "HIGHEST SUPPORT"],
    ] as const).map(([k, label]) => ({ label, name: best[k]?.name ?? "—", value: best[k]?.value ?? 0, sideId: best[k]?.sideId ?? null }));

    // VIPs in game means live GRANTS, not the cosmetic profile marker — and a paused grant is
    // exactly the state of not having VIP right now.
    const nowMs = Date.now();
    const vipIds = new Set(
      (await repo.vips.list(server.id))
        .filter((v) => !(v.pausedUntil && Date.parse(v.pausedUntil) > nowMs))
        .filter((v) => !v.expiration || Date.parse(v.expiration) > nowMs)
        .map((v) => v.playerId),
    );
    const vips = roster.filter((pl) => vipIds.has(rosterIdOf(pl))).length;

    // Next map is the rotation entry after the current one, wrapping — the same reading the live
    // view uses, and it stays right when a vote schedules its winner into that slot.
    const rot = (rawRotation ?? null) as { currentIndex?: number; mAPS?: { name?: string }[] } | null;
    const maps = Array.isArray(rot?.mAPS) ? rot.mAPS : [];
    const nextMap = maps.length ? maps[((rot?.currentIndex ?? 0) + 1) % maps.length]?.name ?? null : null;

    // The map's own artwork and the faction emblems, from the files the panel ships — the worker
    // runs the same image, so they are on disk beside it. All of it keyed by the server's GAME:
    // a Vietnam round must never wear WW2 nations, emblems or map pictures.
    const art = await loadMapArt(server.game, session.mapId || session.mapName);
    const at = new Date();

    // The board is a PICTURE. A Discord embed is a fixed template and cannot be made to look like a
    // scoreboard, so the message carries a rendered PNG and nothing else. The embed is kept as the
    // fallback for a host where the renderer can't load — a plainer board beats no board.
    const image = await renderBoard({
      serverName: server.name, session, sides, totals, leaders, vips, at,
      art: art?.bytes ?? null,
      emblems: await loadEmblems(server.game, sides, session.mapId || session.mapName),
      icons: await loadScoreIcons(),
      logo: await loadBoardLogo(repo),
      title: board.title ?? null,
      factionNames: factionNamesFor(server.game, sides, session.mapId || session.mapName),
    }, slog);

    const embed = image ? null : buildStatusEmbed({
      serverName: board.title?.trim() || server.name, session, sides, totals, vips, nextMap, mapArt: art?.name ?? null, at,
    }) as unknown as Record<string, unknown>; // an interface isn't a Record; the shape is identical
    // The drawn board changes every tick, so it is re-sent every tick; the embed's map artwork only
    // changes with the map, and an edit that sends no file leaves the attachment where it is.
    const file = image ?? (art?.name !== board.imageName ? art : null);
    const stamp = image ? image.name : art?.name ?? null;

    if (board.messageId) {
      const outcome = await editMessage(discordToken(), channelId, board.messageId, embed ? [embed] : [], file);
      if (outcome === "ok") {
        const back = quiet.ok(`status-board:${server.id}`);
        if (back.recovered) slog.info("the Discord match board is updating again", { afterAttempts: back.runs, wasBroken: forDuration(back.sinceMs) });
        if (stamp !== board.imageName) await repo.discordRelay.patchBoardState(server.id, { messageId: board.messageId, imageName: stamp });
        return true;
      }
      // A network blip keeps the id: re-posting on every hiccup is precisely the duplicate spam
      // the single-message design exists to prevent. Only a 404 earns a new message.
      if (outcome === "failed") return true;
      slog.warn("status board message is gone, posting a new one", { channelId, messageId: board.messageId });
    }
    const posted = await postMessageTracked(discordToken(), channelId, embed ? [embed] : [], file);
    if (!posted) return true;
    // patchBoardState, never upsertConfig: this write happens seconds after `board` was read, and a
    // staff save in that window must not be clobbered by the stale snapshot — nor may that save
    // lose the id just posted, or the next tick posts a second board.
    await repo.discordRelay.patchBoardState(server.id, { messageId: posted, imageName: stamp });
    slog.info("status board posted", { channelId, messageId: posted, drawn: Boolean(image) });
    return true;
  } catch (err) {
    // A board that stops updating LOOKS fine — it just shows an older round forever, which is
    // exactly the failure staff cannot spot from the outside.
    const v = quiet.fail(`status-board:${server.id}`);
    if (v.speak) slog.warn("the Discord match board is not updating — it will keep showing whatever it last drew", { server: server.name, attempts: v.runs, failing: forDuration(v.sinceMs), err: (err as Error).message });
    else slog.debug("status board skipped", { err: (err as Error).message });
    return true;
  }
}

/**
 * Draw the board, or nothing.
 *
 * The renderer pulls in a native canvas; a host where that can't load must still get a board, so a
 * failure here is a downgrade to the plain embed rather than an error. JPEG because the picture is
 * mostly photograph and it is re-sent on every tick — a third of the bytes for no visible loss.
 */
async function renderBoard(input: BoardImageInput, slog: Logger): Promise<{ name: string; bytes: Uint8Array } | null> {
  try {
    // Off the event loop: the draw is seconds of CPU, and this process's one loop also runs every
    // server's ingest. The thread falls back to an inline render if it cannot run at all.
    return { name: "match.jpg", bytes: await renderBoardOffThread(input) };
  } catch (err) {
    slog.warn("could not draw the match board, falling back to the embed", { err: (err as Error).message });
    return null;
  }
}

/** The faction emblems for a round, keyed by side id, for the scoreline. Empty when the game's
 *  nations are unknown — no emblem beats the wrong country's insignia. */
async function loadEmblems(game: string, sides: { id: string }[], mapKey: string | null | undefined): Promise<Record<string, Uint8Array | null>> {
  const nations = nationsFor(game, mapKey);
  if (!nations) return {};
  const [allies, axis] = nations;
  const out: Record<string, Uint8Array | null> = {};
  if (sides[0]) out[sides[0].id] = await loadEmblem(game, allies.code);
  if (sides[1]) out[sides[1].id] = await loadEmblem(game, axis.code);
  return out;
}

/** "UNITED STATES" / "GERMANY" — the nations actually in this round, not the generic side labels.
 *  Empty for a game the nations table doesn't know: the renderer then falls back to the game
 *  descriptor's own side labels, which are at least never the wrong war. */
function factionNamesFor(game: string, sides: { id: string }[], mapKey: string | null | undefined): Record<string, string> {
  const nations = nationsFor(game, mapKey);
  if (!nations) return {};
  const [allies, axis] = nations;
  const out: Record<string, string> = {};
  if (sides[0]) out[sides[0].id] = allies.name;
  if (sides[1]) out[sides[1].id] = axis.name;
  return out;
}

/**
 * Fold one roster read into the per-match and career stat rollups.
 *
 * Separate from the composition snapshot above because the two answer different questions and fail
 * differently: a lost snapshot is a gap in a chart, whereas these are counters that only ever move
 * forward, so the store's fold is written to be idempotent and this is safe to retry.
 *
 * The whole roster goes in one call. At a minute apiece on a hundred-player server this is the
 * exact shape that became an N+1 in the live view, and it is not being repeated here.
 */
async function foldRosterStats(
  repo: Repository,
  server: ServerRow,
  raw: Record<string, unknown>[],
  slog: Logger,
): Promise<void> {
  try {
    // Which roles lead a squad is game knowledge, so it comes from the descriptor rather than
    // numbers written here — HLL names three (officer, spotter, tank commander, one per squad
    // type), another game will name something else.
    const slRoles = new Set(getGame(server.game)?.descriptor?.squadLeaderRoles ?? []);
    const players = raw.map((p) => {
      const role = p?.role == null ? null : Number(p.role);
      const score = (p?.scoreData ?? {}) as Record<string, unknown>;
      const stats = (p?.stats ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      return {
        platformId: rosterPlayerId(p),
        name: p?.name == null ? undefined : String(p.name),
        role,
        isSquadLead: role != null && slRoles.has(role),
        level: n(p?.level),
        score: {
          // "cOMBAT" is the server's own spelling, not a typo on our side.
          combat: n(score.cOMBAT ?? score.combat),
          offense: n(score.offense),
          defense: n(score.defense),
          support: n(score.support),
          vehicleKills: n(stats.vehicleKills),
          vehiclesDestroyed: n(stats.vehiclesDestroyed),
          // The game's own kill/death counters, which sit in this very object and were being
          // skipped. They are NOT the kill stream's numbers: the game's kill counter also moves on
          // an assist and its death counter on a redeploy, which is exactly why CRCON keeps both
          // and publishes these as kills_and_assists / deaths_and_redeploys.
          killsAndAssists: n(stats.infantryKills),
          deathsAndRedeploys: n(stats.deaths),
        },
        // The squad INDEX, not the display platoon name — CRCON's UnitHistoryEntry.squad is an int
        // and the public API republishes it raw. Unassigned stays null rather than becoming 0,
        // which is a real squad.
        squad: p?.platoonIndex == null ? null : n(p.platoonIndex),
      };
    }).filter((p) => p.platformId);
    if (players.length === 0) return;

    const match = await repo.matches.getOpen(server.id).catch(() => null);
    await repo.stats.sampleRoster({
      serverId: server.id,
      matchId: match?.id ?? null,
      sampleSec: Math.round(ROSTER_SNAPSHOT_MS / 1000),
      players,
    });
    slog.debug("roster stats folded", { players: players.length, match: match?.id ?? null });
    const back = quiet.ok(`stats-fold:${server.id}`);
    if (back.recovered) slog.info("roster stats are being recorded again", { afterAttempts: back.runs, wasBroken: forDuration(back.sinceMs) });
  } catch (err) {
    // Never let a stats fold tear down the loop it rides on, same rule as the snapshot above.
    //
    // But say so: this is the write that accumulates every player's kills, playtime and score. A
    // silent failure here does not break a screen, it stops history happening — and the first
    // symptom is someone asking why the leaderboard has not moved in a week.
    const v = quiet.fail(`stats-fold:${server.id}`);
    if (v.speak) slog.warn("player stats are not being recorded — kills and playtime stop accumulating while this lasts", { server: server.name, attempts: v.runs, failing: forDuration(v.sinceMs), err: (err as Error).message });
    else slog.debug("roster stats fold skipped", { err: (err as Error).message });
  }
}

/**
 * Automated map-vote loop. One connection per server on a slow poll. When enabled with a Discord
 * channel + token, it keeps a native poll running: on `MATCH ENDED` it closes the poll, applies the
 * winner via the tested placement (dry-run on observe servers), and opens the next poll — options
 * composed by the active scheduled profile. The Discord poll is the only surface for now (REST-only);
 * the winner is always applied by raw map id.
 *
 * It also carries the behaviours that make the vote trustworthy rather than merely automatic:
 *  - the leading option is kept queued as the next map continuously (`liveApply`), so an early or
 *    unexpected match end still lands on what players chose;
 *  - a pause is a real pause — the open vote's options are parked and the same vote comes back;
 *  - voting stands itself down while the server is empty and picks itself back up;
 *  - staff can start a vote, re-read the map list, or push the vote in game at any moment.
 */
/**
 * Thrown to escape the tick loop when a game read that can never legitimately be empty (the map
 * reference list, the rotation) comes back empty: the RCON session has wedged in a way that only a
 * reconnect fixes. Production showed exactly this — both servers composing 0 options for hours,
 * healed the instant the worker restarted — so the loop now forces that restart itself.
 */
class RconSessionWedgedError extends Error {
  constructor(what: string) { super(`${what} — reconnecting to the server`); this.name = "RconSessionWedgedError"; }
}

async function mapVoteServer(repo: Repository, server: ServerRow, ctl: RunnerControl): Promise<void> {
  if (!automationEnabled(server.automation, "mapvote")) return parkDisabled(ctl);
  let lastMatchEndAt = "";
  let lastMatchStartAt = "";
  let prevPollOptionIds: string[] = [];
  // Reminder tracking (per match, in-process): when the current match began (by detection) and which
  // reminder offsets we've already broadcast for it.
  let matchStartMs = 0;
  let sentReminders = new Set<number>();
  let lastMatchEndMs = 0;
  /*
   * The second witness to a match ending. The vote only ever learned of one from the admin log's
   * MATCH ENDED line; a line lost to a log-read gap left the poll up forever — the Discord card
   * timed out on its own and the panel went on saying "Active, 0 votes" for hours (field report).
   * So the map IN PLAY is watched too: the first read after a poll opens notes it, and a
   * different map seen on two checks running is a match that ended without the log saying so.
   */
  let pollMapWatch = null as PollMapWatch | null;
  /*
   * The map catalogue the last ballot was composed from. The replay guard below names the map in
   * play from the session; most builds report its id, and the ones that report only a printable
   * name need this to turn it back into one. Kept across ticks so the guard costs no extra read.
   */
  let catalogueCache: CurrentMapCatalogueItem[] = [];
  /*
   * The map the open poll's own round is being played on, as the 60-second check reads it from the
   * session while nothing about the map is changing. Keyed by the poll, so a new ballot never
   * inherits the previous round's map. The end-of-round apply bars it (queueing the round that is
   * ending replays it) and so does the live tracker; neither may use the map in play at the moment
   * it reads, which — once the next map has loaded — is the map players just picked.
   */
  let pollRound = null as { messageId: string; mapId: string } | null;
  /** The map in play the "nothing eligible to queue" warning was last given for — once per map,
   *  not every tick of a round the vote cannot do anything about. */
  let warnedNoPick: string | null = null;
  /*
   * The round end whose handling already went out to a reconnect once. A dead session is retried on
   * a fresh one — but only once per round end: a rotation that keeps reading empty (a build the
   * reader does not know, say) would otherwise re-read the same end and reconnect forever, with the
   * vote never reset and no new ballot ever posted. The second failure is recorded and passed.
   */
  let reconnectedFor: string | null = null;

  // The configured startup posture is applied ONCE per process, not once per connection. The loop
  // below reconnects on every RCON error, and re-applying "start paused" there would silently
  // re-pause a vote a few seconds after staff resumed it.
  let startupApplied = false;

  // Registration lookups, remembered across ticks. The surfaces below are rebuilt every pass (they
  // are deliberately stateless, so a restart mid-vote loses nothing), which left every tally
  // re-asking the database whether each voter has a Discord link — once per voter, every thirty
  // seconds, for the whole life of a vote. These outlive the tick so the answer is fetched once;
  // the TTL is what lets a player who links mid-vote start counting without a restart.
  const REGISTRATION_TTL_MS = 5 * 60_000;
  const linkOfCached = ttlMemo<string | null>(
    async (playerId) => (await repo.externalLinks.list(playerId)).find((l) => l.provider === "discord")?.externalId ?? null,
    REGISTRATION_TTL_MS,
  );
  const isRegisteredCached = ttlMemo<boolean>(
    async (discordId) => !!(await repo.externalLinks.findPlayer("discord", discordId)),
    REGISTRATION_TTL_MS,
  );

  const blank = () => blankMapVoteState(server.id);

  while (!ctl.stopped) {
    const client = gameClientFor(server);
    const slog = log.child({ serverId: server.id, server: server.name });
    try {
      await connectGameClient(client, server);
      const boot = (await repo.mapVote.getState(server.id)) ?? blank();
      lastMatchEndAt = boot.lastMatchEndAt ?? new Date().toISOString();
      lastMatchStartAt = new Date().toISOString();
      while (!ctl.stopped) {
        const cfg = await repo.mapVote.getConfig(server.id);
        // "Startup" means the first config this process reads, whether or not the vote is on. Were
        // the flag only set once past the guard below, a vote that was switched off at boot and
        // enabled a week later would get the startup posture applied then — pausing a vote someone
        // had just deliberately turned on.
        const bootPass = !startupApplied;
        startupApplied = true;
        // The surfaces: "native" is the Discord poll, "ingame" is chat-number voting (no Discord
        // needed at all — what reaches console players), and "both" runs the two together with
        // the ballots COMBINED for the final score. Any Discord half keeps the channel + token
        // requirement; "embed" stays reserved and parks the loop.
        const hasIngame = cfg?.surface === "ingame" || cfg?.surface === "both";
        const hasDiscord = cfg?.surface === "native" || cfg?.surface === "both";
        if (!cfg || !cfg.enabled || (!hasIngame && !hasDiscord) || (hasDiscord && (!cfg.channelId || !discordToken()))) {
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }
        // Registration = a linked Discord (the VIP panel registration). These two lookups are what
        // "only registered voters" and the cross-surface dedupe key on. Both read through the
        // per-server memos above, so an open vote costs one lookup per voter per TTL rather than
        // one per voter per tick.
        /*
         * This one KEEPS its catch, unlike the registration check below, and the asymmetry is
         * deliberate. It is consulted per voter while folding the in-game ballot, so a failure that
         * escapes takes the whole in-game read down — and the combined surface's fallback for an
         * unreadable half is that half's own tally, which is derived from this same fold and fails
         * the same way. The half would contribute zero. Answering null costs one voter their ballot
         * on one tick (the memo does not cache failures, so the next tally asks again), which is a
         * far smaller error than losing everyone who voted in game.
         */
        const discordLinkOf = async (playerId: string) => linkOfCached(playerId).catch(() => null);
        const registeredAmong = async (discordIds: string[]) => {
          const out = new Set<string>();
          for (const dId of new Set(discordIds)) {
            // No per-id catch: a lookup that failed has not told us this person is unregistered,
            // and answering "no" on its behalf discounts a real vote. The whole check fails
            // instead, and the surface treats that as "the gate could not be applied".
            if (await isRegisteredCached(dId)) out.add(dId);
          }
          return out;
        };
        // A gate only applies where its surface is actually running: leaving "in-game votes must be
        // registered" switched on and moving the vote to Discord-only must not go on shaping a
        // ballot that has no in-game half — least of all the wording of the result posted to the
        // channel, which would otherwise announce a restriction nobody was under.
        const gateIngame = hasIngame && cfg.registeredOnlyIngame;
        const gateDiscord = hasDiscord && cfg.registeredOnlyDiscord;
        const ingameSurface = hasIngame
          ? new InGameChatVote({
              serverId: server.id,
              query: (q) => repo.events.query(q),
              // The client already keeps the observe promise (writes are dry-run there).
              announce: async (message) => { await client.execute("broadcast", { message }); },
              registeredOnly: gateIngame, linkOf: discordLinkOf,
              log: slog,
            })
          : null;
        const discordSurface = hasDiscord ? new NativeDiscordPoll(discordToken(), cfg.channelId ?? "", cfg.pollHours) : null;
        // The combined wrapper carries "both", and ALSO a Discord-only vote with registered-only
        // on — the poll card counts every click, and the wrapper's exact close is where the
        // unregistered ones stop counting.
        const surface: VoteSurface = discordSurface && (ingameSurface || gateDiscord)
          ? new CombinedVoteSurface(discordSurface, ingameSurface, {
              registeredOnlyDiscord: gateDiscord, registeredOnlyIngame: gateIngame,
              registeredAmong, log: slog,
            })
          : (ingameSurface ?? discordSurface!);
        let state = (await repo.mapVote.getState(server.id)) ?? blank();

        if (bootPass) {
          const want = cfg.startupState === "paused" ? true : cfg.startupState === "active" ? false : null;
          if (want !== null && want !== state.paused) {
            // A poll left open by the previous process is stale either way: pausing must take it
            // down, and resuming wants a fresh one rather than a poll whose deadline has passed.
            if (state.activeMessageId) {
              try { await surface.close({ messageId: state.activeMessageId, channelId: state.activeChannelId ?? cfg.channelId ?? "" }, state.options.length); }
              catch { /* best-effort: it may already be gone */ }
            }
            state = await repo.mapVote.patchState(server.id, {
              paused: want,
              pauseReason: want ? "startup" : null,
              // Keep the options when pausing so Resume can put the same vote back, exactly as a
              // manual pause does; drop them when starting active so a new poll gets drawn.
              savedOptions: want ? (state.options.length ? state.options : state.savedOptions) : [],
              activeMessageId: null, activeChannelId: null, options: [], tallies: [], talliedAt: null,
            });
            slog.info("mapvote startup state applied", { startupState: cfg.startupState, paused: want });
          }
        }
        // Only the columns this tick actually decided. `state` was read before the Discord round
        // trips above, so writing the whole row from it reverted anything staff pressed meanwhile
        // — pause looked like it worked and then un-paused itself a tick later.
        const persist = (patch: MapVoteStatePatch) =>
          repo.mapVote.patchState(server.id, { lastMatchEndAt, ...patch });

        // Why the next map is not tracking the vote leader, kept where staff can read it. Written
        // only when the answer CHANGES: this runs every tick, and a settle window would otherwise
        // be a row write and a log line every few seconds for five minutes.
        const noteLiveApply = async (reason: string | null) => {
          if ((state.liveApplyNote ?? null) === reason) return;
          await persist({ liveApplyNote: reason });
          state = { ...state, liveApplyNote: reason };
          if (reason) slog.info("map vote: next map is not tracking the leader", { reason });
        };

        /*
         * Only the two match-boundary kinds, and only since the older cursor. This read runs
         * every tick on every server with a vote configured, forever, and used to pull the newest
         * 300 rows of EVERYTHING — kills included — to find match starts and ends that happen a
         * handful of times an hour. The cursors are ISO strings set before the first tick, so the
         * lower bound is always real; `from` is inclusive where the filters below are exclusive,
         * which costs at most re-reading the cursor row itself.
         */
        const cursorFrom = lastMatchStartAt < lastMatchEndAt ? lastMatchStartAt : lastMatchEndAt;
        const recent = await repo.events.query({
          serverId: server.id, kinds: ["evt.match.started", "evt.match.ended"], from: cursorFrom, limit: 300,
        }).catch(() => []);
        // "" when the surface is in-game (no channel to have): every Discord helper below is
        // either ingame-guarded or catches its own failure, so the empty id can never act.
        const channelId = cfg.channelId ?? "";
        const handleOf = (s: MapVoteStateRow) => ({ messageId: s.activeMessageId!, channelId: s.activeChannelId ?? channelId });
        /**
         * When a new ballot goes up, it is the only thing left in the channel.
         *
         * Nothing spent has a function: a closed poll cannot be voted in, and its full tally lives
         * in the panel's vote history. Deleting the previous ballot BY ID was not enough, because
         * the leftovers are not only ballots — Discord posts its own message every time a poll
         * closes ("…'s poll has closed! The results were tied"), which outlives the poll it
         * describes, and a ballot whose id we lost to a restart was never deleted at all. So the
         * sweep asks who posted a message rather than trying to remember every id: everything this
         * bot left here goes, the live ballot stays, and anything a person wrote is untouched.
         *
         * On OPEN, never on close: Discord's result line lands moments after a poll expires, so
         * sweeping at close would race it and leave the very message this is meant to remove.
         */
        const sweepChannel = async (keepMessageId: string | null) => {
          // A channel id left over from a Discord-poll era must not be swept by an in-game vote.
          if (!hasDiscord || !cfg.tidyChannel || !discordToken() || !channelId) return;
          /*
           * The keep id must be the id DISCORD knows. A combined vote's handle stores both
           * halves ("<discordId>|ingame:<iso>"), and the sweep spares a message only when its
           * raw snowflake matches — handed the composite, it recognised nothing, and the ballot
           * it had JUST POSTED went out with the spent one it was meant to remove. Every vote
           * cleared itself moments after opening, on exactly the configuration the combined
           * surface was built for.
           */
          const keep = discordMessageIdOf(keepMessageId);
          // What OTHER servers' votes still need here: two servers pointed at one channel used to
          // erase each other's live ballots every round, because the by-author sweep spared only
          // its own. No catches on these reads — a sweep that cannot learn what is live must not
          // delete anything (it is cosmetic; the next open tries again).
          let siblings: SiblingVoteState[];
          try {
            const all = await repo.servers.list();
            siblings = await Promise.all(all.filter((o) => o.id !== server.id).map(async (o) => {
              const [ocfg, ost] = await Promise.all([repo.mapVote.getConfig(o.id), repo.mapVote.getState(o.id)]);
              return {
                serverId: o.id, activeMessageId: ost?.activeMessageId ?? null, activeChannelId: ost?.activeChannelId ?? null,
                configChannelId: ocfg?.channelId ?? null, pauseNoticeId: ost?.pauseNoticeId ?? null,
              };
            }));
          } catch (err) {
            slog.warn("map vote channel sweep skipped — could not learn what other servers' votes need", { err: (err as Error).message });
            return;
          }
          // Both the current channel AND the one the last vote closed in: staff who move the vote
          // channel between rounds otherwise leave the spent ballot standing in the old channel
          // forever, since no future sweep would ever look there again.
          for (const target of channelsToSweep(channelId, state.lastClosedChannelId)) {
            try {
              const spare = [...(keep ? [keep] : []), ...spareForSiblingVotes(target, server.id, siblings)];
              const r = await sweepOwnMessages(discordToken(), target, spare);
              if (r.removed) slog.info("map vote channel cleared", { channelId: target, removed: r.removed });
              // A refusal is the operator's to fix, so it is said out loud with the fix in it. Left at
              // debug, the only symptom was a channel filling with spent ballots and no explanation
              // anywhere — which is exactly how this went unnoticed through a week of rounds.
              if (r.refused) {
                slog.warn("map vote channel could not be cleared — Discord refused", {
                  channelId: target, refused: r.refused, status: r.status,
                  hint: r.status === 403
                    ? "the bot needs Manage Messages (and Read Message History) in that channel"
                    : "check the bot's access to that channel",
                });
              }
            } catch (err) {
              // The history read itself failed: without Read Message History the sweep cannot even
              // see what to remove, and every round quietly leaves another closed poll behind.
              const status = (err as { status?: number }).status ?? 0;
              slog.warn("map vote channel sweep failed", {
                channelId: target, status, err: (err as Error).message,
                hint: status === 403 ? "the bot needs Read Message History in that channel" : undefined,
              });
            }
          }
          await repo.mapVote.patchState(server.id, { lastClosedMessageId: null, lastClosedChannelId: null }).catch(() => {});
        };

        const closeQuietly = async (s: MapVoteStateRow) => {
          if (!s.activeMessageId) return;
          try { await surface.close(handleOf(s), s.options.length); } catch { /* best-effort: the poll may already be gone */ }
        };
        /**
         * The options with each one's votes and — where the surface can tell us — who cast them.
         * Reading voters costs a request per option, so it happens once as a vote ends, never in
         * the polling loop. If it fails we still record the totals: a vote with no names attached
         * beats no record at all.
         */
        const optionsWithBallot = async (s: MapVoteStateRow, counts: number[] | null) => {
          let voters: { discordId: string; name: string }[][] = [];
          if (s.activeMessageId) {
            try { voters = await surface.voters(handleOf(s), s.options.length); }
            catch (err) { slog.debug("mapvote voter read failed", { err: (err as Error).message }); }
          }
          return s.options.map((o, i) => ({
            ...o,
            votes: counts?.[i] ?? s.tallies?.[i] ?? 0,
            ...(voters[i] ? { voters: voters[i] } : {}),
          }));
        };
        /** Take the "voting is paused" notice down, if one is up. */
        const clearNotice = async (s: MapVoteStateRow) => {
          if (s.pauseNoticeId) await deleteMessage(discordToken(), channelId, s.pauseNoticeId);
        };
        /** The rotation, for edits made while a round is in play. */
        const liveRotationIO: RotationIO = {
          getRotation: async () => {
            const rot = stateReaderFor(server.game).rotation(await client.readState("maprotation"));
            // A live HLL server always has at least the map being played in rotation; the
            // parsers degrade unrecognised answers to empty rather than throwing. Empty
            // here is therefore the same wedged-session signal as an empty catalogue, and
            // mutating the rotation on top of a bad read cannot end well.
            if (rot.maps.length === 0) throw new RconSessionWedgedError("the map rotation read empty");
            return rot;
          },
          addMapToRotation: async (m, index) => { await client.execute("addMapToRotation", { mapName: m, index }); },
          removeMapFromRotation: async (index, mapId) => { await client.execute("removeMapFromRotation", { mapName: mapId, index }); },
        };
        /**
         * The map in play, from the session ALONE. The rotation cannot be the fallback here the way
         * it is for the ballot: the vote leaves one map in it, so it names the map about to play,
         * and asking it "what is on" answers "the next map" — which would make every rotation look
         * like a replay. Null when the session cannot say.
         */
        const readInPlay = async (): Promise<string | null> => {
          const raw = await client.readState("session").catch(() => null);
          return raw ? resolveCurrentMapId({ session: normalizeSession(raw), catalogue: catalogueCache }) : null;
        };
        /** The map this poll's round is being played on (see pollRound), or null when unknown. */
        const roundMapOf = (s: MapVoteStateRow): string | null =>
          pollRound && s.activeMessageId && pollRound.messageId === s.activeMessageId ? pollRound.mapId : null;
        /** The name players know a map by: staff's display name where set, the inferred one otherwise. */
        const displayNameOf = async (mapId: string): Promise<string> =>
          (await repo.mapNames.list(server.game).catch(() => []))
            .find((n) => n.mapId.toLowerCase() === mapId.toLowerCase())?.displayName || describeMap(mapId).prettyName;
        /**
         * The replay guard's write: queue `mapId` because the rotation was about to play the map in
         * play again. Said on the trail, because it means something upstream did not queue a map.
         */
        const queueOverReplay = async (mapId: string, inPlay: string, why: string) => {
          await scheduleNextMap(liveRotationIO, mapId);
          await repo.audit.create({
            actorUserId: null, actorName: "mapvote", action: "mapvote.replayGuard",
            targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
            summary: `the server was about to replay ${inPlay} — set the next map to ${mapId} (${why})`,
            data: { mapId, inPlay, why },
          }).catch(() => {});
          slog.warn("map vote: the next map was the one in play — queued another", { mapId, inPlay, why });
        };

        /**
         * Compose a ballot from the map set in force: the catalogue, the map in play, the recent
         * maps, any payout event's pinned set and the schedule. Shared by the vote's open and by the
         * round-end fallback, which needs a map the vote WOULD have offered.
         */
        const composeBallot = async (cur: MapVoteStateRow) => {
          const [rawList, rawRotation, rawSession, overrideRows] = await Promise.all([
            client.execute("getMapReferenceList").catch(() => null),
            client.readState("maprotation").catch(() => null),
            client.readState("session").catch(() => null),
            repo.mapNames.list(server.game),
          ]);
          // Both staff overrides: the display name players read, and the family the engine groups
          // variants by (one option per map, and resting a whole family after it plays).
          const overrides = new Map(overrideRows.map((r) => [r.mapId, r]));
          const catalogue = describeMaps(stateReaderFor(server.game).mapCatalogue(rawList))
            .map((m) => ({ ...m, prettyName: overrides.get(m.id)?.displayName ?? m.prettyName, family: overrides.get(m.id)?.family ?? m.family }));
          if (catalogue.length) catalogueCache = catalogue;
          if (catalogue.length === 0) {
            // The reference list is served by the game itself and is never empty on a healthy
            // connection. An empty read means the RCON session has gone bad in a way only a
            // reconnect fixes — production showed both servers stuck composing 0 options for
            // hours, healed the moment the worker restarted. Throwing to the connection handler
            // forces that reconnect instead of warning "0 options" forever on a dead session.
            await repo.mapVote.patchState(server.id, { recentMaps: cur.recentMaps, lastMatchEndAt, lastOpenError: "the game returned an empty map list — reconnecting to the server" }).catch(() => {});
            throw new RconSessionWedgedError("the game returned an empty map list");
          }
          const rot = stateReaderFor(server.game).rotation(rawRotation);
          // The map in PLAY, from the session. The rotation cannot say: this runner collapses it
          // to the single map the vote is queuing, so its "current" entry is the map about to
          // start. Taken from there, the just-won map was banked as recently-played and barred
          // from the next vote, while the map everybody was actually on stayed eligible.
          const currentMap = resolveCurrentMapId({ session: normalizeSession(rawSession), rotation: rot, catalogue }) ?? undefined;
          // Roll the map that's in play now into the recent-played list (newest first, de-duped).
          // The cap is what the exclusion windows can actually reach back through: the editor
          // offers up to 20 rounds, and a shorter memory than that silently truncated the
          // setting — asking not to re-offer the last 20 quietly meant the last 10.
          const recentMaps = currentMap ? [currentMap, ...cur.recentMaps.filter((m) => m !== currentMap)].slice(0, RECENT_MAPS_MEMORY) : cur.recentMaps;
          const playerCount = stateReaderFor(server.game).playerCount(rawSession);
          // An OPEN payout event may pin one of this server's profiles for its duration —
          // event maps while the event runs, whatever the schedule would have chosen. A pin
          // naming a profile that no longer exists falls through to the schedule (the profile
          // was renamed/deleted after the event was created), logged so staff can see why the
          // event maps did not come up.
          // Boundaries first. `status` only becomes "open" when a sweep resolves it, and that
          // timer runs on its own minute — so an event due to open at 20:00 could still read
          // "scheduled" here, and the vote for its FIRST round (the one the pin was set for)
          // would compose from the schedule instead. Resolving inline costs one small query per
          // vote open, which happens once a round, and makes the pin exact.
          //
          // A failure is reported, not swallowed: a pin that quietly stops applying looks
          // exactly like staff setting it wrong, and leaves nothing to find.
          let pinned;
          try {
            await sweepPayoutEvents(repo);
            // Oldest first (pending() orders by creation), so two overlapping pinned events
            // resolve the same way every time rather than by whichever row came back first.
            pinned = (await repo.payoutEvents.pending())
              .find((ev) => ev.serverId === server.id && ev.status === "open" && ev.mapVoteProfile);
          } catch (e) {
            slog.warn("could not check for a payout event's pinned map-vote profile — using the schedule", { err: (e as Error).message });
          }
          const profiles = (cfg.profiles ?? []) as unknown as MapVoteProfile[];
          let resolved = pinned ? resolvePinnedPool(profiles, pinned.mapVoteProfile!) : null;
          if (pinned && !resolved) slog.warn("event pins a map-vote profile that no longer exists — using the schedule", { event: pinned.name, profile: pinned.mapVoteProfile });
          resolved = resolved ?? resolveActivePool(profiles, new Date(), { playerCount }, cfg.timezone);
          const poll = buildPoll({ catalogue, config: resolved.config, currentMapId: currentMap, recentIds: recentMaps, previousPollIds: prevPollOptionIds });
          // The strict reading of the map in play (session only), for the replay guard.
          const inPlay = resolveCurrentMapId({ session: normalizeSession(rawSession), catalogue });
          return { poll, resolved, recentMaps, rot, inPlay };
        };
        /**
         * The round-end and no-ballot half of the replay guard: when no vote is up to queue a map,
         * and the rotation would play the map in play again, queue a map the vote WOULD have
         * offered (the ballot is shuffled, so its first eligible option is a random pick from the
         * map set in force, never the map in play nor anything its exclusions rest).
         */
        const fallbackOverReplay = async (b: Awaited<ReturnType<typeof composeBallot>>, why: string, overrideMapId: string | null) => {
          if (server.engagementMode !== "active" || !b.inPlay) return;
          // A standing staff override is queued in the ballot's place: it is the forced next map
          // whether or not a vote is up to carry it (and onto the map in play, a replay staff chose).
          const pick = replayGuardPick({ rotation: b.rot, inPlay: b.inPlay, options: b.poll.options, overrideMapId });
          if (pick) { warnedNoPick = null; await queueOverReplay(pick, b.inPlay, overrideMapId ? `${why} — the staff override` : why); return; }
          if (!overrideMapId && replayQueued(b.rot, b.inPlay) && warnedNoPick !== b.inPlay) {
            warnedNoPick = b.inPlay;
            slog.warn("map vote: the server is set to replay the map in play and no other map is eligible to queue", { inPlay: b.inPlay, summary: b.poll.summary });
          }
        };
        /** Past the settle after a match end (see shouldApplyLiveLeader): the new round has its map. */
        const settled = () => !lastMatchEndMs || cfg.postMatchApplyDelaySeconds <= 0
          || Date.now() - lastMatchEndMs >= cfg.postMatchApplyDelaySeconds * 1000;

        // --- live tally: park the current counts so the panel shows them without hitting Discord ---
        // Written when the counts MOVE (or every few minutes, so "counted at" stays honest) — the
        // row used to be rewritten every tick of every open vote with the same numbers.
        if (state.activeMessageId && state.options.length) {
          try {
            const messageId = state.activeMessageId;
            const handle = handleOf(state);
            // The counts, with the in-game ballot's voters off the same chat read (vote-surface.ts).
            const read = surface.tallyWithVoters
              ? await surface.tallyWithVoters(handle, state.options.length)
              : { counts: await surface.tally(handle, state.options.length), ingame: null };
            const counts = read.counts;
            const changed = counts.length !== (state.tallies ?? []).length || counts.some((c, i) => c !== state.tallies?.[i]);
            const stale = !state.talliedAt || Date.now() - Date.parse(state.talliedAt) >= STATE_HEARTBEAT_MS;
            if (changed || stale) await persist({ tallies: counts, talliedAt: new Date().toISOString() });
            state = { ...state, tallies: counts };
            // Who voted in game, for the public vote_status, which lists voters as CRCON's does.
            // Written when the list moves, and tagged with this vote so the next ballot never shows it.
            if (read.ingame) {
              const voters = await listIngameVoters(read.ingame, async (ids) => new Map((await repo.players.findByIds(ids)).map((p) => [p.id, p.platformId])));
              const ingameVoters = { messageId, voters };
              if (JSON.stringify(ingameVoters) !== JSON.stringify(state.ingameVoters)) await persist({ ingameVoters });
              state = { ...state, ingameVoters };
            }
          } catch (err) { slog.debug("mapvote tally read failed", { err: (err as Error).message }); }
        }

        // --- match-start reminders: message "vote on Discord" nudges at configured offsets ---
        const starts = recent.filter((e) => e.kind === "evt.match.started" && e.ts > lastMatchStartAt);
        for (const e of starts) if (e.ts > lastMatchStartAt) lastMatchStartAt = e.ts;
        if (starts.length > 0) { matchStartMs = Date.now(); sentReminders = new Set(); }
        // Only while a ballot is actually up: composition can fail (a pool thinned below two
        // options, a Discord refusal), and the reminder path did not check — players in game were
        // told "vote for the next map on Discord" with nothing there to vote on. The staff
        // announce path below has always required the open poll; the automatic one now matches.
        if (matchStartMs > 0 && cfg.reminders.length && server.engagementMode === "active" && !state.paused && state.activeMessageId) {
          const elapsedMin = (Date.now() - matchStartMs) / 60_000;
          for (let i = 0; i < cfg.reminders.length; i++) {
            const r = cfg.reminders[i]!;
            if (elapsedMin >= r.minutesAfterMatchStart && !sentReminders.has(i)) {
              sentReminders.add(i);
              const msg = buildVoteAnnouncement({
                header: String(r.message), layout: (r.layout ?? "none") as VoteMessageLayout,
                options: state.options, tallies: state.tallies,
                // In-game voting: the number beside each map IS the ballot, so every list the
                // players see carries the numbers, in a fixed order.
                numbered: hasIngame,
              });
              /**
               * A MESSAGE, not a broadcast. The broadcast is the line that scrolls across the top
               * left and is gone a few seconds later — a reminder sent that way is one a player
               * looking at their squad, the map, or anything else simply never sees, which is
               * exactly what was happening. `messageEveryone` sends the top-right message that
               * stays put until the player acknowledges it, which is what a "vote for the next
               * map" nudge wants. It costs one send per player, so it is paced.
               */
              try {
                // Staff-written reminder headers may use placeholders — each recipient's copy is theirs.
                const rr = rendererFor(repo, server, client);
                const out = await messageEveryone(client, hasPlaceholders(msg) ? (pl) => rr.render(msg, pl) : msg, {
                  onError: (playerId, err) => slog.debug("map-vote reminder did not reach one player", { playerId, err: err.message }),
                });
                slog.info("map-vote reminder sent in game", { found: out.found, sent: out.sent, failed: out.failed });
              } catch (err) { slog.warn("the map-vote reminder did not reach players in game", { err: (err as Error).message }); }
            }
          }
        }

        // --- staff asked to push the vote to everyone in game right now ---
        if (state.sendMessageLayout) {
          const layout = state.sendMessageLayout as VoteMessageLayout;
          if (state.activeMessageId && server.engagementMode === "active") {
            const msg = buildVoteAnnouncement({
              header: hasIngame && hasDiscord
                ? "Vote for the next map — on Discord, or type the map's NUMBER in team or unit chat"
                : hasIngame
                  ? "Vote for the next map — type the map's NUMBER in team or unit chat"
                  : "Everyone may vote for the next map on Discord",
              layout, options: state.options, tallies: state.tallies, numbered: hasIngame,
            });
            // Same reasoning as the reminder above: staff pressing "tell everyone" mean the message
            // that waits to be acknowledged, not a line that scrolls past while people are shooting.
            try {
              const ar = rendererFor(repo, server, client);
              const out = await messageEveryone(client, hasPlaceholders(msg) ? (pl) => ar.render(msg, pl) : msg, {
                onError: (playerId, err) => slog.debug("map-vote announce did not reach one player", { playerId, err: err.message }),
              });
              slog.info("map vote announced in game", { layout, found: out.found, sent: out.sent, failed: out.failed });
            } catch (err) { slog.warn("map vote announce failed", { err: (err as Error).message }); }
          }
          await persist({ sendMessageLayout: null });
          state = { ...state, sendMessageLayout: null };
        }

        // --- staff asked for a vote right now: bin whatever is open and compose a fresh one ---
        if (state.startNow) {
          if (state.activeMessageId) {
            const options = await optionsWithBallot(state, null);
            await closeQuietly(state);
            await repo.mapVote.recordHistory({
              serverId: server.id, profile: state.profile, options,
              winnerId: null, winnerName: null,
              totalVotes: (state.tallies ?? []).reduce((n, v) => n + v, 0),
              outcome: "restarted", applied: false,
            }).catch(() => {});
          }
          // A staff restart is a full reset: the previous-poll exclusion is deliberately dropped,
          // because with a small curated pool it can make every recompose come up short — Start
          // vote must always be the escape hatch that CAN open something, even the same maps.
          prevPollOptionIds = [];
          await clearNotice(state);
          await persist({
            activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null,
            tallies: [], talliedAt: null, savedOptions: [], pauseNoticeId: null, paused: false,
            pauseReason: null, liveAppliedMapId: null, liveApplyNote: null, reopenAt: null, startNow: false,
            // Start vote is the button that outranks everything — including the stand-down a
            // manual map change put up. Staff pressing it during the hold mean "vote NOW".
            manualHoldUntil: null,
          });
          state = { ...blank(), recentMaps: state.recentMaps, resyncNow: state.resyncNow };
          slog.info("map vote restarted by staff", { resync: state.resyncNow });
        }

        // --- voting stands itself down while nobody is playing, and picks itself back up ---
        if (cfg.pauseBelowPlayers > 0) {
          const count = stateReaderFor(server.game).playerCount(await client.readState("session").catch(() => null));
          if (count !== null) {
            if (count < cfg.pauseBelowPlayers && !state.paused) {
              // Park the options so the SAME vote returns when players do.
              await closeQuietly(state);
              const notice = hasDiscord ? await postEmbedTracked(discordToken(), channelId, buildPausedEmbed("empty", server.name)) : null;
              await persist({
                paused: true, pauseReason: "empty", savedOptions: state.options, pauseNoticeId: notice,
                activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null,
                tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null,
              });
              state = { ...state, paused: true, pauseReason: "empty", savedOptions: state.options, pauseNoticeId: notice, activeMessageId: null, options: [] };
              slog.info("map vote auto-paused: server is quiet", { players: count, threshold: cfg.pauseBelowPlayers });
            } else if (count >= cfg.pauseBelowPlayers && state.paused && state.pauseReason === "empty") {
              // Only an automatic pause lifts itself — a staff pause stays until staff resumes it.
              await clearNotice(state);
              await persist({ paused: false, pauseReason: null, pauseNoticeId: null });
              state = { ...state, paused: false, pauseReason: null, pauseNoticeId: null };
              slog.info("map vote auto-resumed: players are back", { players: count });
            }
          }
        }

        // --- staff asked to skip this vote: close it, apply nothing, record why ---
        if (state.skipNext) {
          if (state.activeMessageId) {
            const options = await optionsWithBallot(state, null);
            await closeQuietly(state);
            await repo.mapVote.recordHistory({
              serverId: server.id, profile: state.profile, options,
              winnerId: null, winnerName: null,
              totalVotes: (state.tallies ?? []).reduce((n, v) => n + v, 0),
              outcome: "skipped", applied: false,
            }).catch(() => {});
            if (hasIngame) await client.execute("broadcast", { message: "The map vote was skipped by staff — the rotation continues as normal." }).catch(() => {});
            if (hasDiscord) await postMessage(discordToken(), channelId, "🗺️ The map vote was skipped by staff — the rotation continues as normal.").catch(() => {});
          }
          await persist({ activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null, tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null, skipNext: false, lastClosedMessageId: state.activeMessageId, lastClosedChannelId: state.activeChannelId ?? channelId });
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }

        // --- staff asked for different options: bin this poll so the open step composes a new one ---
        if (state.reroll) {
          if (state.activeMessageId) {
            await closeQuietly(state);
            prevPollOptionIds = state.options.map((o) => o.id); // don't offer the same set again
          }
          // reopenAt cleared too: a reroll during the post-apply settle window means "options NOW",
          // not "keep waiting out the delay I can't see".
          await persist({ activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null, tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null, reroll: false, reopenAt: null, lastClosedMessageId: state.activeMessageId, lastClosedChannelId: state.activeChannelId ?? channelId });
          state = { ...state, activeMessageId: null, options: [], reroll: false, reopenAt: null };
        }

        // --- paused: park the open vote's options, tell players why, and open nothing ---
        if (state.paused) {
          if (state.activeMessageId) {
            await closeQuietly(state);
            const notice = state.pauseNoticeId
              ?? (hasDiscord ? await postEmbedTracked(discordToken(), channelId, buildPausedEmbed(state.pauseReason === "empty" ? "empty" : "staff", server.name)) : null);
            // Parking the options is what makes this a pause: resuming puts the SAME vote back up,
            // rather than throwing away what players had already voted on.
            await persist({
              savedOptions: state.options, pauseNoticeId: notice, activeMessageId: null, activeChannelId: null,
              options: [], profile: null, openedAt: null, tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null,
            });
            slog.info("map vote paused", { reason: state.pauseReason ?? "staff", parked: state.options.length });
          }
          // Rounds that end while paused are the pause's, not rounds the vote failed to settle. Left
          // unread, they were all read at once on the first pass after Resume, and the replay guard
          // below took them for a round that ended with no vote open — queueing a map of its own at
          // the moment staff handed the vote back. Read here instead (and the cursor kept, so a
          // restart mid-pause does not bring them back), the pause leaves the rotation to staff.
          let pausedEnd = false;
          for (const e of recent) {
            if (e.kind === "evt.match.ended" && e.ts > lastMatchEndAt) { lastMatchEndAt = e.ts; pausedEnd = true; }
          }
          if (pausedEnd) {
            lastMatchEndMs = Date.now();
            await persist({});
          }
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }

        // --- just un-paused: take the notice down, and let the open step restore the parked vote ---
        if (state.pauseNoticeId) {
          await clearNotice(state);
          await persist({ pauseNoticeId: null });
          state = { ...state, pauseNoticeId: null };
        }

        // --- staff changed the map BY HAND: stand down until the hold expires ---
        // The manual change ends the round, which is exactly the moment the branch below would
        // close the open vote and queue ITS winner over the human's pick — so this runs first.
        // The open vote is closed without applying anything (its round is the one staff just
        // ended), nothing re-opens before the hold is up, and that window is staff's chance to
        // pause or switch voting off if the change is meant to stick. Start vote still outranks
        // this: the startNow branch above clears the hold before it is ever read here.
        if (state.manualHoldUntil && Date.parse(state.manualHoldUntil) > Date.now()) {
          if (state.activeMessageId && state.options.length) {
            const options = await optionsWithBallot(state, null);
            await closeQuietly(state);
            await repo.mapVote.recordHistory({
              serverId: server.id, profile: state.profile, options,
              winnerId: null, winnerName: null,
              totalVotes: (state.tallies ?? []).reduce((n, v) => n + v, 0),
              outcome: "held", applied: false,
            }).catch(() => {});
            const minutes = Math.max(1, Math.ceil((Date.parse(state.manualHoldUntil) - Date.now()) / 60_000));
            if (hasIngame) await client.execute("broadcast", { message: `Staff changed the map, so this vote closed without a winner — voting starts again in about ${minutes} minute(s).` }).catch(() => {});
            if (hasDiscord) await postMessage(discordToken(), channelId, `🗺️ Staff changed the map by hand — the open vote closed without applying a winner. Voting resumes in about ${minutes} minute(s).`).catch(() => {});
            slog.info("map vote standing down for a manual map change", { until: state.manualHoldUntil });
          }
          // The next vote waits out the LONGER of the hold and whatever settle delay already stood.
          const reopenAt = state.reopenAt && state.reopenAt > state.manualHoldUntil ? state.reopenAt : state.manualHoldUntil;
          if (state.activeMessageId || state.reopenAt !== reopenAt) {
            await persist({
              activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null,
              tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: "staff changed the map by hand — the vote is standing down",
              savedOptions: [], reopenAt,
              lastClosedMessageId: state.activeMessageId ?? state.lastClosedMessageId, lastClosedChannelId: state.activeMessageId ? (state.activeChannelId ?? channelId) : state.lastClosedChannelId,
            });
            state = { ...state, activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null, tallies: [], savedOptions: [], reopenAt };
          }
        } else if (state.manualHoldUntil) {
          // Only the hold this tick read: a staff map change extends it, and that extension can
          // land after the snapshot above was taken.
          const hold = await clearLapsedVoteHold(state.manualHoldUntil, {
            read: async () => (await repo.mapVote.getState(server.id))?.manualHoldUntil,
            clear: () => persist({ manualHoldUntil: null }),
          });
          state = { ...state, manualHoldUntil: hold };
        }

        // --- match ended: close the poll, apply the override (if set) or the vote winner ---
        const ends = recent.filter((e) => e.kind === "evt.match.ended" && e.ts > lastMatchEndAt);
        for (const e of ends) if (e.ts > lastMatchEndAt) lastMatchEndAt = e.ts;
        if (ends.length > 0) lastMatchEndMs = Date.now();
        /*
         * A round ended with no vote up to settle it: one could not be composed or posted, or it
         * opened too late. Nothing else will queue a map before the next one loads, and the vote
         * left the rotation holding only the map now ending — so without this, it plays again.
         * Not during a staff stand-down: that round end is the manual change, and the map it
         * loads is the one staff chose. And only a round that has JUST
         * ended: this exists to act before the next map loads, and a backlog read late (voting
         * switched back on, the worker back from downtime) is long past that point — the vote
         * that opens now takes the rotation from there.
         */
        if (ends.length > 0 && !state.activeMessageId && server.engagementMode === "active"
          && !(state.manualHoldUntil && Date.parse(state.manualHoldUntil) > Date.now())
          && Date.now() - Date.parse(lastMatchEndAt) <= FRESH_ROUND_END_MS) {
          try {
            if (state.overrideMapId) {
              // A staff override with no vote up to carry it is the forced next map all the same,
              // and this is the round end it was set for. Spent once used, as when a vote applies it.
              const forced = state.overrideMapId;
              await scheduleNextMap(liveRotationIO, forced);
              await persist({ overrideMapId: null });
              state = { ...state, overrideMapId: null };
              await repo.audit.create({
                actorUserId: null, actorName: "mapvote", action: "mapvote.apply",
                targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
                summary: `set next map to ${await displayNameOf(forced)} (staff override — no vote was open)`,
                data: { mapId: forced, override: true, voteOpen: false },
              }).catch(() => {});
              slog.info("map vote: applied the staff override at a round end with no vote open", { mapId: forced });
            } else {
              // Two reads first: a ballot is composed only when the rotation really is set to replay.
              const inPlay = await readInPlay();
              if (inPlay && replayQueued(await liveRotationIO.getRotation(), inPlay)) {
                await fallbackOverReplay(await composeBallot(state), "the round ended with no vote open", null);
              }
            }
          } catch (e) {
            slog.warn("map vote: could not queue a map for a round that ended with no vote open", { err: (e as Error).message });
            // Once per round end, as for the apply below: a fresh session gets one more go at it.
            if (isDeadSession(e) && reconnectedFor !== lastMatchEndAt) { reconnectedFor = lastMatchEndAt; throw e; }
          }
        }
        if (ends.length > 0 && state.activeMessageId && state.options.length) {
          // Outside the try, so a failure can still say on the trail which map it could not queue.
          let applyId: string | null = null; let applyName = "";
          try {
            let counts: number[] | null = null;
            let detail: string;
            // Whether the result went to an option nobody voted for (the default pick).
            let noVotes = false;
            // The result loaded before this match end was read (see resolveRoundResult).
            let alreadyInPlay = false;
            if (state.overrideMapId) {
              await closeQuietly(state);
              applyId = state.overrideMapId;
              // The override is announced under the same name the poll options carry: the custom
              // display name when staff set one, the inferred pretty name otherwise. Without the
              // overlay, a renamed map was announced under its auto name by the very message that
              // interrupts a poll showing the custom one.
              applyName = await displayNameOf(state.overrideMapId);
              detail = "staff override";
            } else {
              /*
               * A count that cannot be read at the whistle is not a reason to apply nothing. That
               * was the whole of this branch: one failed read (Discord slow, a rate limit, the
               * message gone) threw past the apply, nothing was queued, and the rotation — which
               * the vote had left holding only the map now ending — played it again. The tally
               * read every few seconds through the round stands in instead.
               */
              let fromLastRead = false;
              try { counts = await surface.close(handleOf(state), state.options.length); }
              catch (err) {
                fromLastRead = true;
                counts = state.options.map((_, i) => state.tallies?.[i] ?? 0);
                slog.warn("mapvote: the final count could not be read — applying from the last count read", { err: (err as Error).message });
              }
              // The round that is ending cannot win — queueing it replays it — and a result that
              // loaded before this end was read is reported, not queued twice (resolveRoundResult).
              const result = resolveRoundResult({ options: state.options, counts, roundMap: roundMapOf(state), inPlay: await readInPlay() })!;
              const winner = result.winner;
              alreadyInPlay = result.alreadyInPlay;
              noVotes = winner.noVotes;
              prevPollOptionIds = state.options.map((o) => o.id);
              applyId = winner.option.id; applyName = winner.option.name;
              detail = (winner.noVotes
                ? (counts.some((c) => c > 0) ? "its only votes were for the map just played — default pick" : "no votes — default pick")
                : `${winner.count} vote${winner.count === 1 ? "" : "s"}`)
                + (fromLastRead ? ", from the last count read" : "");
            }
            const dryRun = server.engagementMode !== "active";
            if (!dryRun && !alreadyInPlay) {
              /*
               * The next map loads as soon as the scoreboard closes, so an edit the game refused,
               * or one that did not verify, is tried again now: the next chance to queue anything
               * is after that map has loaded. A wedged or dropped session is NOT tried again on
               * the same session — the live edit refuses an empty rotation read rather than
               * inserting the winner into it on every attempt — and goes out to the reconnect.
               */
              const target = applyId;
              for (let attempt = 1; ; attempt++) {
                try { await scheduleNextMap(liveRotationIO, target); break; }
                catch (err) {
                  if (isDeadSession(err) || attempt >= 3 || ctl.stopped) throw err;
                  slog.warn("mapvote: queueing the result failed — trying again", { attempt, err: (err as Error).message });
                  await ctl.sleep(2_000);
                }
              }
            }
            await repo.audit.create({
              actorUserId: null, actorName: "mapvote", action: "mapvote.apply",
              targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
              summary: alreadyInPlay
                ? `the vote's result, ${applyName} (${detail}), was already in play when the match end was read — nothing to queue`
                : `${dryRun ? "[dry-run] would set" : "set"} next map to ${applyName} (${detail})`,
              data: { mapId: applyId, counts, profile: state.profile, override: !!state.overrideMapId, dryRun, alreadyInPlay },
            }).catch(() => {});
            await repo.mapVote.recordHistory({
              serverId: server.id, profile: state.profile,
              options: await optionsWithBallot(state, counts),
              winnerId: applyId, winnerName: applyName,
              // The override branch never reads the final counts (the poll is closed quietly), so
              // the running tallies stand in — the same numbers the option rows carry. Reducing
              // over `counts ?? []` there recorded totalVotes 0 on a row whose own options showed
              // the votes, and the history page rendered an overridden vote as "0 votes cast".
              totalVotes: (counts ?? state.tallies ?? []).reduce((n, v) => n + v, 0),
              // Judged on the result, not the raw counts: votes only for the map just played left
              // the default pick, and the row must not call that a vote while saying "no votes".
              outcome: state.overrideMapId ? "override" : noVotes ? "no_votes" : "vote",
              applied: !dryRun,
            }).catch(() => {});
            // Nothing is posted to the channel when a vote closes. Discord's own poll card closes
            // itself and shows the final bars and shares in place, so a second message restating the
            // same numbers is noise — and the hand-drawn version of it was worse than noise on a
            // phone. The result is kept where it is actually asked for: the panel's vote history,
            // with the full tally and who voted for what.
            //
            // The IN-GAME ballot has no card that shows its own result, so there the winner is
            // announced where the votes were cast — a broadcast as the next round loads.
            if (hasIngame && !dryRun) {
              await client.execute("broadcast", { message: `Map vote: ${applyName} won (${detail}) — ${alreadyInPlay ? "it is the map being played now" : "it is queued as the next map"}.` }).catch(() => {});
            }
            // And when the DISCORD side is on but its card cannot tell the whole story — the
            // in-game half contributed ballots, or registered-only discounted some clicks — the
            // combined result is posted to the channel, option by option in ballot order.
            if (hasDiscord && (hasIngame || gateDiscord) && counts && !state.overrideMapId) {
              // undefined when this surface is not the combined wrapper (a plain Discord poll's
              // counts are always its own exact numbers).
              const closeExact = surface instanceof CombinedVoteSurface ? surface.closeWasExact(handleOf(state)) : undefined;
              const lines = state.options.map((o, i) => `${o.id === applyId ? "**" : ""}${i + 1}. ${o.name} — ${counts[i] ?? 0}${o.id === applyId ? "** 🏆" : ""}`);
              const total = counts.reduce((n, v) => n + v, 0);
              await postMessage(
                discordToken(),
                channelId,
                // When the close could not read a half by name, or could not apply a gate, the
                // number is the best available rather than the exact one — and a post that says
                // "counted, registered voters only" about an estimate is the app vouching for
                // arithmetic it did not do.
                `🗺️ **Map vote result** — **${applyName}** (${detail}, ${total} ${closeExact === false ? "counted as best we could read" : "counted"}${
                  closeExact === false ? "" :
                  gateDiscord && gateIngame ? ", registered voters only"
                  : gateDiscord ? ", registered Discord voters only"
                  : gateIngame ? ", in-game votes registered only" : ""
                }${hasIngame ? ", Discord + in game combined" : ""}).\n${lines.join("\n")}`,
              ).catch(() => {});
            }
            slog.info("map vote applied", { mapId: applyId, override: !!state.overrideMapId });
          } catch (e) {
            /*
             * A session only a reconnect can heal: go to it now, with nothing below run. The poll
             * stays open and the persisted match-end cursor unmoved, so the fresh session reads
             * this match end again and settles it then — closing a poll a second time and
             * recounting it are both harmless. Swallowed here, the result was simply lost.
             */
            if (isDeadSession(e) && reconnectedFor !== lastMatchEndAt) {
              reconnectedFor = lastMatchEndAt;
              slog.warn("mapvote: the session died while applying the result — reconnecting to apply it", { err: (e as Error).message, mapId: applyId });
              throw e;
            }
            slog.warn("mapvote close/apply failed", { err: e });
            // On the trail, not only in the log: a round whose result never reached the server
            // otherwise leaves no row anywhere, and the replay that follows looks unexplained.
            await repo.audit.create({
              actorUserId: null, actorName: "mapvote", action: "mapvote.applyFailed",
              targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
              summary: applyId
                ? `could not set the next map to ${applyName}: ${(e as Error).message}`
                : `could not settle the vote as the match ended: ${(e as Error).message}`,
              data: { mapId: applyId, profile: state.profile },
            }).catch(() => {});
          }
          // A forced map is spent once it has been used — leaving it set would silently override
          // every future vote too. The next vote starts clean, and the settle delay holds it back
          // until players have loaded into the match that just began.
          await persist({
            activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null,
            tallies: [], talliedAt: null, overrideMapId: null, liveAppliedMapId: null, liveApplyNote: null, savedOptions: [],
            reopenAt: new Date(Date.now() + cfg.pollResetDelaySeconds * 1000).toISOString(),
            // Hold the spent ballot's id so the next vote can clear it from the channel. Not
            // deleted here: Discord posts its own "the winner was X" line against this poll a
            // moment after it closes, and that line is the part worth keeping.
            lastClosedMessageId: state.activeMessageId, lastClosedChannelId: state.activeChannelId ?? channelId,
          });
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }

        // --- a match that ended without MATCH ENDED reaching the log (see pollMapWatch) ---
        // Recovery is a ROLLOVER, not the end-of-match apply: the map has already changed, so
        // queueing the old vote's winner now would land it a match late (or queue a default pick
        // nobody chose). Live apply already teed the leader up while the match ran. The old poll
        // is closed, its tally kept on the trail, and a fresh vote opens for the match in play.
        if (state.activeMessageId && state.options.length && Date.now() - (pollMapWatch?.lastCheckMs ?? 0) >= MISSED_END_CHECK_MS) {
          const sess = normalizeSession(await client.readState("session").catch(() => null));
          const mapKey = String(sess.mapId || sess.mapName || "").trim().toLowerCase();
          const now = Date.now();
          const step = pollMapWatchStep(pollMapWatch, { messageId: state.activeMessageId, mapKey, nowMs: now });
          pollMapWatch = step.watch;
          if (step.rolledOverFrom !== null) {
            const from = step.rolledOverFrom;
            let counts: number[] | null = null;
            try { counts = await surface.close(handleOf(state), state.options.length); }
            catch (e) { slog.warn("mapvote: closing the stranded poll failed", { err: (e as Error).message }); }
            prevPollOptionIds = state.options.map((o) => o.id);
            lastMatchEndAt = new Date(now).toISOString();
            lastMatchEndMs = now;
            matchStartMs = now; sentReminders = new Set();
            await repo.audit.create({
              actorUserId: null, actorName: "mapvote", action: "mapvote.missedEnd",
              targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
              summary: `the map changed (${from} → ${mapKey}) but the game's MATCH ENDED line never reached the log — the vote rolled over to a fresh poll without applying (the leader, if any, was already queued live)`,
              data: { from, to: mapKey, counts, options: state.options.map((o) => o.id) },
            }).catch(() => {});
            slog.warn("map vote: a match ended without MATCH ENDED in the log — rolled the vote over", { from, to: mapKey });
            await persist({
              activeMessageId: null, activeChannelId: null, options: [], profile: null, openedAt: null,
              tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null, savedOptions: [],
              reopenAt: new Date(now + cfg.pollResetDelaySeconds * 1000).toISOString(),
              lastClosedMessageId: state.activeMessageId, lastClosedChannelId: state.activeChannelId ?? channelId,
            });
            await ctl.sleep(MAPVOTE_POLL_MS); continue;
          }

          // --- the replay guard: while a vote is up, the next map is never the map in play ---
          /*
           * Applying the vote's result at MATCH ENDED is the only thing that moves the rotation on,
           * and once the map it queued has loaded the rotation names nothing else. Live apply only
           * acts once somebody has voted, so on a quiet server — overnight, say — the rotation went
           * the whole round set to play the same map again, and a round end the vote did not act
           * on (the log line lost, the apply refused) replayed it. Worse, the watch above cannot
           * see that: it looks for the map CHANGING, and a replay is the same map. So the vote's
           * current pick is queued as soon as the round has settled — the leader when there are
           * votes, the default pick (a random option) when there are none. The result at MATCH
           * ENDED still replaces it, exactly as before; this only decides what plays when nothing
           * else gets the chance to. A staff override is left to the override, even onto the map
           * in play: that replay is one staff asked for. It is a mid-round edit, so only with live
           * apply on: switched off, the panel promises the next map is set only as the match ends.
           */
          const seen = resolveCurrentMapId({ session: sess, catalogue: catalogueCache });
          // The map of this poll's round — only while the watch agrees nothing about it is changing.
          if (seen && pollMapWatch && !pollMapWatch.changedTo) pollRound = { messageId: state.activeMessageId, mapId: seen };
          // Not while the watch above is waiting to confirm a map change: that round is this vote's
          // no longer, and the vote that replaces it queues its own pick.
          const inPlay = cfg.liveApply && server.engagementMode === "active" && settled() && !pollMapWatch?.changedTo ? seen : null;
          if (inPlay) {
            try {
              const pick = replayGuardPick({
                rotation: await liveRotationIO.getRotation(), inPlay,
                options: state.options, tallies: state.tallies ?? [], overrideMapId: state.overrideMapId,
              });
              if (pick) {
                await scheduleNextMap(liveRotationIO, pick);
                // What is queued, for the live tracker: it moves the rotation on only when the leader
                // CHANGES, so it has to know a pick is already standing there.
                await persist({ liveAppliedMapId: pick });
                state = { ...state, liveAppliedMapId: pick };
                slog.info("map vote: queued the vote's current pick so the map in play does not replay", { mapId: pick, inPlay });
              }
            } catch (e) {
              slog.warn("map vote: could not queue the vote's current pick over a replay", { err: (e as Error).message });
              if (isDeadSession(e)) throw e;
            }
          }
        }

        // --- keep the next map pointed at whatever is currently winning ---
        // A vote that is only counted when the match ends is a gamble on the match ending cleanly.
        // Re-queueing the leader as votes come in means the map players picked is always the one
        // teed up, whatever happens. A forced map takes the place of the leader while it is set.
        if (state.activeMessageId && state.options.length) {
          const leader = state.overrideMapId
            ? { id: state.overrideMapId, votes: 1 }
            : (() => {
                const w = resolveVoteWinner(state.options, state.tallies ?? [], { exclude: roundMapOf(state) });
                return w && !w.noVotes ? { id: w.option.id, votes: w.count } : null;
              })();
          const decision = shouldApplyLiveLeader({
            enabled: cfg.liveApply,
            leaderId: leader?.id ?? null,
            alreadyAppliedId: state.liveAppliedMapId,
            totalVotes: state.overrideMapId ? 1 : (state.tallies ?? []).reduce((n, v) => n + v, 0),
            lastMatchEndAt: lastMatchEndMs,
            now: Date.now(),
            postMatchApplyDelayMs: cfg.postMatchApplyDelaySeconds * 1000,
          });
          if (decision.apply && leader) {
            const dryRun = server.engagementMode !== "active";
            try {
              if (!dryRun) {
                await scheduleNextMap(liveRotationIO, leader.id);
                await persist({ liveAppliedMapId: leader.id, liveApplyNote: null });
                state = { ...state, liveAppliedMapId: leader.id, liveApplyNote: null };
                slog.info("map vote: next map now tracking the leader", { mapId: leader.id, votes: leader.votes });
              } else {
                /*
                 * Observe mode: nothing was sent, so the tracker must not claim the leader is
                 * queued. It used to record it anyway, which reads as harmless until the server is
                 * switched to active mid-poll — the tracker then says "leader unchanged" against a
                 * rotation it never touched, and the map players are voting for is never queued
                 * for that round. Exactly the failure the resumed-poll reset above exists to
                 * prevent, arriving by a different door.
                 *
                 * The note carries the reason to the panel instead, and dedupes itself, so a
                 * read-only server explains its standing-by once rather than every tick.
                 */
                await noteLiveApply("observe mode — the leader is followed here but never queued on the server");
              }
            } catch (e) {
              slog.warn("mapvote live apply failed", { err: e, mapId: leader.id });
              await noteLiveApply(`could not queue the leader: ${(e as Error).message}`);
              // A wedged session heals only by reconnecting — do it now, mid-poll, rather than
              // failing this apply every tick until the match ends. A dead socket is the same
              // situation wearing a different name: swallowing it here left the runner talking to
              // a connection that could never answer, for the whole life of the poll.
              // RconCommandError is excluded even though it subclasses RconConnectionError: the
              // game ANSWERING "no" to a rotation edit is not a dead socket, and reconnecting
              // over it would just re-ask the same refused question on a fresh connection.
              if (isDeadSession(e)) throw e;
            }
          } else if (!decision.apply) {
            // The tracker knows exactly why it is standing down; without recording it, a vote whose
            // leader is never queued looks identical from the panel to one that is working.
            // "leader unchanged" is the steady state of a working tracker, not a problem — say so.
            await noteLiveApply(decision.reason === "leader unchanged" ? null : decision.reason);
          }
        }

        // --- no active poll → restore the parked one, or compose + open a fresh one ---
        const cur = (await repo.mapVote.getState(server.id)) ?? blank();
        if (!cur.activeMessageId && cur.reopenAt && Date.now() < Date.parse(cur.reopenAt)) {
          // Settling after a match end: players are still loading in, so hold the next vote back.
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }
        // Coming back from a pause: put the SAME vote up again rather than starting over.
        if (!cur.activeMessageId && cur.savedOptions.length >= 2) {
          try {
            const handle = await surface.open("Vote for the next map", cur.savedOptions);
            await repo.mapVote.patchState(server.id, {
              activeMessageId: handle.messageId, activeChannelId: handle.channelId,
              options: cur.savedOptions, savedOptions: [], openedAt: new Date().toISOString(),
              tallies: [], talliedAt: null, reopenAt: null, lastMatchEndAt, lastOpenError: null,
              // The resumed poll starts from zero votes, so the tracker must start from zero too.
              // Left set, it still believed it had queued the paused poll's leader: when that map
              // led again the decision came back "leader unchanged" and nothing was re-queued —
              // while the rotation had long since moved on to the map that actually played.
              liveAppliedMapId: null, liveApplyNote: null,
            });
            await sweepChannel(handle.messageId);
            slog.info("map vote resumed with its parked options", { options: cur.savedOptions.length });
          } catch (e) {
            await repo.mapVote.patchState(server.id, { lastOpenError: `could not reopen the parked poll: ${(e as Error).message}` }).catch(() => {});
            slog.warn("mapvote resume failed", { err: (e as Error).message });
          }
          await ctl.sleep(MAPVOTE_POLL_MS); continue;
        }
        if (!cur.activeMessageId) {
          // Kept outside the try: a ballot that could not be POSTED still names a map to queue.
          let ballot: Awaited<ReturnType<typeof composeBallot>> | null = null;
          // No vote is going to settle this round, so nothing would move the rotation on either.
          // A mid-round edit, so only with live apply on (see the replay guard above); off, the
          // round-end fallback is the one that acts, as the match ends.
          const queueFallback = async (why: string) => {
            if (!ballot || !cfg.liveApply || !settled()) return;
            await fallbackOverReplay(ballot, why, cur.overrideMapId).catch((e: unknown) => {
              slog.warn("map vote: could not queue a map while no vote could open", { err: (e as Error).message });
            });
          };
          try {
            ballot = await composeBallot(cur);
            const { poll, resolved, recentMaps } = ballot;
            if (poll.options.length >= 2) {
              const handle = await surface.open("Vote for the next map", poll.options);
              await repo.mapVote.patchState(server.id, { activeMessageId: handle.messageId, activeChannelId: handle.channelId, options: poll.options, profile: resolved.profileName, openedAt: new Date().toISOString(), recentMaps, tallies: [], talliedAt: null, liveAppliedMapId: null, liveApplyNote: null, reopenAt: null, resyncNow: false, lastMatchEndAt, lastOpenError: null });
              await sweepChannel(handle.messageId);
              slog.info("map vote opened", { profile: resolved.profileName, options: poll.options.length, resync: cur.resyncNow, ...(poll.alwaysSkipped ? { alwaysSkipped: poll.alwaysSkipped } : {}) });
            } else {
              // Not opening is a state the control page must be able to SEE. Staff pressing Start
              // vote against a pool the exclusions have thinned below two options otherwise watch
              // nothing happen, with the reason confined to this log line.
              // The engine's own diagnosis leads when it has one: it names WHICH filter emptied the
              // pool, which is the difference between clearing an exclusion list and chasing a
              // connection fault. The raw counts follow it, for whoever wants the arithmetic.
              const why = poll.diagnosis
                ? `No vote could be composed — ${poll.diagnosis}. (${poll.summary})`
                : `only ${poll.options.length} option${poll.options.length === 1 ? "" : "s"} could be composed (${poll.summary || "pool too thin after exclusions"}) — check the active map set's pool against its exclusions`;
              await repo.mapVote.patchState(server.id, { recentMaps, resyncNow: false, lastMatchEndAt, lastOpenError: why });
              slog.warn("map vote: fewer than 2 options composed — not opening", { options: poll.options.length, summary: poll.summary, diagnosis: poll.diagnosis });
              await queueFallback("no vote could be composed");
            }
          } catch (e) {
            // A bad connection propagates: the reconnect is the fix, and staying in this loop
            // would keep failing against the same dead session.
            if (e instanceof RconSessionWedgedError) throw e;
            // Same principle for a failed Discord post (bad channel, missing permission, outage):
            // the reason lands on the state where the panel shows it, not only in this log.
            await repo.mapVote.patchState(server.id, { lastOpenError: `could not open the ${hasIngame && hasDiscord ? "combined vote" : hasIngame ? "in-game vote" : "Discord poll"}: ${(e as Error).message}` }).catch(() => {});
            slog.warn("mapvote open failed", { err: e });
            await queueFallback("the vote could not be posted");
          }
        }

        await ctl.sleep(MAPVOTE_POLL_MS);
      }
    } catch (err) {
      slog.error("mapvote connection error, will reconnect", { err: (err as Error).message, reconnectMs: RECONNECT_MS });
    } finally {
      await client.disconnect().catch(() => {});
    }
    prevPollOptionIds = []; matchStartMs = 0; sentReminders = new Set();
    if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
  }
}

/**
 * Rotating auto-broadcast runner. One persistent connection per server; it cycles the configured
 * messages through the game's `broadcast` command every `intervalSec`. No-ops (staying connected so
 * re-enabling is prompt) until enabled with at least one message. Sending is suppressed when the
 * config is in dry-run OR the server isn't in active engagement mode — the same rule the enforcer
 * and seeding use. The rotation index + last-send time are per-connection memory (reset on reconnect).
 */
const GAME_REWARDS_TICK_MS = 60_000;
/**
 * Play-days attendance: while that reward is on, every minute each player on the roster is
 * credited the minute to today (community timezone). The moment a player's day crosses the
 * minimum, their streak is evaluated — once a day each, not every minute. Holds no connection
 * while it is off.
 */
async function gameRewardsServer(repo: Repository, server: ServerRow, ctl: RunnerControl): Promise<void> {
  const slog = log.child({ serverId: server.id, server: server.name });
  const wanted = async () => {
    gameRewardsCache.delete(server.id);
    const c = await gameRewardsFor(repo, server.id);
    return c?.playDays.enabled ? c : null;
  };
  while (!ctl.stopped) {
    if (!(await wanted())) { await ctl.sleep(GAME_REWARDS_TICK_MS); continue; }
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      let lastTickMs = Date.now();
      while (!ctl.stopped) {
        const cfg = await wanted();
        if (!cfg) break;
        await ctl.sleep(GAME_REWARDS_TICK_MS);
        const now = Date.now();
        const secs = Math.min(120, Math.max(0, Math.round((now - lastTickMs) / 1000)));
        lastTickMs = now;
        const roster = rosterPlayers(await client.readState("players")); // throws if the connection died → reconnect
        if (!roster.length || !secs) continue;
        const tz = await serverTimezone(repo, server.id);
        const today = dayIn(tz, now);
        const need = Math.max(1, cfg.playDays.minMinutes * 60);
        const totals = await repo.gameRewards.addDaySeconds(server.id, "play", today, roster.map((p) => ({ playerId: p.playerId, seconds: secs })));
        for (const t of totals) {
          if (t.seconds < need || t.seconds - secs >= need) continue; // only the tick that crossed it
          const name = roster.find((p) => p.playerId === t.playerId)?.playerName ?? null;
          await rewardDayStreak(repo, server, client, slog, "play", t.playerId, name, today, t.seconds).catch((err) =>
            slog.warn("play-days reward failed", { playerId: t.playerId, err: (err as Error).message }));
        }
      }
    } catch (err) {
      slog.warn("game rewards runner error, reconnecting", { err: (err as Error).message });
      if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

/** How often the live welcome loop re-reads its config while switched off (no connection held). */
const WELCOME_IDLE_MS = Number(process.env.WELCOME_IDLE_MS ?? 30_000);

/**
 * The live welcome message (see WelcomeConfigRow). The game shows ONE stored welcome text to
 * everyone, so this keeps a template, fills its server placeholders, and writes the result to the
 * game — on a timer, never on a join, and only when the text actually changed (compared with what
 * was last written, which survives a restart). A full server churning players costs nothing; a new
 * map or next-map pick costs one write at the next interval. Holds no connection while off.
 */
async function welcomeServer(repo: Repository, server: ServerRow, ctl: RunnerControl): Promise<void> {
  const slog = log.child({ serverId: server.id, server: server.name });
  const wanted = async () => {
    const c = await repo.welcome.getConfig(server.id).catch(() => null);
    return c && c.enabled && c.template.trim() && server.engagementMode === "active" ? c : null;
  };
  while (!ctl.stopped) {
    if (!(await wanted())) { await ctl.sleep(WELCOME_IDLE_MS); continue; }
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      let lastCheckMs = 0;
      let seenUpdatedAt = "";
      while (!ctl.stopped) {
        const cfg = await wanted();
        if (!cfg) break; // switched off: let go of the connection
        const now = Date.now();
        const edited = cfg.updatedAt !== seenUpdatedAt;
        if (edited || now - lastCheckMs >= cfg.intervalSec * 1000) {
          lastCheckMs = now;
          seenUpdatedAt = cfg.updatedAt;
          const filled = appendWelcomeSignature(await repo.signatures.get(), await rendererFor(repo, server, client).render(cfg.template));
          if (welcomeNeedsWrite({ filled, lastText: cfg.lastText, lastWrittenAt: cfg.lastWrittenAt, nowMs: now })) {
            await client.execute("setWelcomeMessage", { message: filled }); // throws if the connection died → reconnect
            await repo.welcome.markWritten(server.id, filled, new Date().toISOString());
            slog.info("live welcome message written", { chars: filled.length });
          }
        }
        const waitMs = Math.max(1_000, Math.min(WELCOME_IDLE_MS, lastCheckMs + cfg.intervalSec * 1000 - Date.now()));
        await ctl.sleep(waitMs);
      }
    } catch (err) {
      slog.warn("live welcome message runner error, reconnecting", { err: (err as Error).message });
      if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
}

async function broadcastServer(repo: Repository, server: ServerRow, ctl: RunnerControl): Promise<void> {
  if (!automationEnabled(server.automation, "broadcast")) return parkDisabled(ctl);
  const live = server.engagementMode === "active"; // observe never sends (client would refuse anyway)
  let idx = 0;
  let lastSentMs = 0;

  while (!ctl.stopped) {
    const client = gameClientFor(server);
    const slog = log.child({ serverId: server.id, server: server.name });
    try {
      await connectGameClient(client, server);
      while (!ctl.stopped) {
        const config = await repo.broadcast.getConfig(server.id);
        if (!config || !config.enabled || config.messages.length === 0) {
          idx = 0; lastSentMs = 0;
          await ctl.sleep(BROADCAST_IDLE_MS);
          continue;
        }
        const now = Date.now();
        const dueAt = lastSentMs === 0 ? now : lastSentMs + config.intervalSec * 1000;
        if (now >= dueAt) {
          const message = config.randomize
            ? config.messages[Math.floor(Math.random() * config.messages.length)]!
            : config.messages[idx % config.messages.length]!;
          idx += 1;
          lastSentMs = now;
          if (live && !config.dryRun) {
            // Server placeholders ({server_name}, {map_name}, {player_count}) fill at send time.
            await client.execute("broadcast", { message: await rendererFor(repo, server, client).render(message) }); // throws if the connection died → reconnect
            slog.info("broadcast sent", { chars: message.length });
          } else {
            slog.debug("broadcast suppressed (dry-run or observe)", { message });
          }
        }
        // Wake in time for the next send, but at least often enough to notice a config change.
        const waitMs = Math.max(1_000, Math.min(BROADCAST_IDLE_MS, (lastSentMs + config.intervalSec * 1000) - Date.now()));
        await ctl.sleep(waitMs);
      }
    } catch (err) {
      slog.warn("broadcast runner error, reconnecting", { err: (err as Error).message });
    } finally {
      await client.disconnect().catch(() => {});
    }
    idx = 0; lastSentMs = 0;
    if (!ctl.stopped) await ctl.sleep(RECONNECT_MS);
  }
}

/** Heartbeat: the worker records its liveness + what it's doing so the API's System view can show
 *  it (the API can't see the worker process directly). Cheap upsert on a short interval. */
async function beat(repo: Repository, activeCount: number): Promise<void> {
  try {
    await repo.heartbeats.upsert({ name: "ingestion", status: "running", detail: { servers: activeCount, pollMs: POLL_MS } });
  } catch { /* heartbeat is best-effort */ }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) log.warn("DATABASE_URL not set — using in-memory store (not persisted)");
  const repo = await createRepository();
  healthRepo = repo; // the connect helper records per-server reachability through this
  // The Discord settings saved in the panel, in this process's environment before anything reads them.
  await applyInstallEnv(repo).catch((err) => log.warn("could not read the install's settings", { err: (err as Error).message }));
  // Publishes live events to the API's plugins. Redis-backed when REDIS_URL is set; without it
  // the events have nowhere to cross to, so ingestion still runs but plugins won't see them.
  if (!process.env.REDIS_URL) log.warn("REDIS_URL not set — live events will not reach the API's plugins");
  const bus = createEventBus({ component: "worker-bus" });
  // The servers' live reads are left for the API's Live page (live-share.ts), which only a Redis
  // bus reaches.
  shareLiveReadsOn(process.env.REDIS_URL ? bus : null);

  // Five loops per server, each on its own connection and its own cadence. All of them no-op until
  // the feature they serve is configured, so every server gets all five.
  const servers = createSupervisor<ServerRow>({
    log,
    fingerprint: connectionFingerprint,
    runners: [
      { what: "ingestion", run: (s, ctl) => ingestServer(repo, bus, s, ctl) },
      // The seeding automod polls the live roster on its own (slow) cadence, independent of
      // admin-log ingestion.
      { what: "seeding", run: (s, ctl) => seedingServer(repo, bus, s, ctl) },

      // Automated map vote: match-end → apply winner → open next poll.
      { what: "map vote", run: (s, ctl) => mapVoteServer(repo, s, ctl) },
      // Rotating auto-broadcast, cycling messages on an interval.
      { what: "broadcast", run: (s, ctl) => broadcastServer(repo, s, ctl) },
      // The live welcome message: fills the welcome text's placeholders, rewriting only on change.
      { what: "welcome", run: (s, ctl) => welcomeServer(repo, s, ctl) },
      // Game rewards' play-days attendance (the other kinds ride on ingestion and seeding).
      { what: "game rewards", run: (s, ctl) => gameRewardsServer(repo, s, ctl) },
      // Auto settings: scheduled/population config profiles AND the roster-state rule triggers,
      // on one connection sharing one roster read per tick.
      { what: "auto settings", run: (s, ctl) => autoSettingsServer(repo, bus, s, ctl) },
    ],
  });

  /**
   * Reconcile the running loops with the servers table: start the new, stop the deleted, restart the
   * reconfigured. Before this was a supervisor it only ever added, which meant a deleted server kept
   * six loops reconnecting to it forever and an edited one kept using the connection details it was
   * started with — so fixing a wrong password in the panel did nothing until the worker restarted.
   */
  const scan = async () => {
    // A restore is replacing the database: stand every runner down exactly the way a deleted
    // server does, and the first scan after the marker clears brings them back against the
    // restored rows (whose changed fingerprints restart the loops with fresh config). Runners
    // half-writing rows while the archive lands is how a restore ends up partial — see the
    // restore-marker module for the whole story.
    if (restoreInProgress()) {
      const changed = servers.sync([]);
      if (changed.stopped.length) log.warn("restore in progress — server runners stood down until it finishes", { stopped: changed.stopped.length });
      return;
    }
    const changed = servers.sync(await repo.servers.list());
    if (changed.started.length || changed.stopped.length || changed.restarted.length) {
      log.info("server runners reconciled", { ...changed, supervised: servers.size });
    }
  };

  // Guarded like the rest: it reads a table, and a database that blinks during one cycle must mean
  // "try again in a minute", not an unhandled rejection that takes every server's connection down
  // with it. The first pass is awaited — unlike the timers below — so the startup log and the first
  // heartbeat report a real server count.
  await scan().catch((err: unknown) => log.warn("server rescan failed", { err: (err as Error).message }));
  if (servers.size === 0) log.info("no servers configured yet — will rescan periodically", { rescanMs: RESCAN_MS });
  const rescan = setInterval(() => background(log, "server rescan", scan), RESCAN_MS);

  /*
   * Every global sweep below goes through this, and none of them runs while a restore is replacing
   * the database. The supervisor already stands the per-server runners down (see `scan`); these
   * timers were not covered by that, and they are the ones that DELETE — a half-loaded table makes
   * a restored VIP grant read as an orphan, a restored request read as expired, a restored ban
   * read as one to lift off the live game server. See sweeps.ts.
   */
  const sweepEvery = (what: string, ms: number, fn: () => Promise<unknown>) =>
    repeatEvery(log, what, ms, whilePaused(what, fn, { paused: restoreInProgress, log }));
  // ...and again on a timer, so a change in the panel reaches the worker without a restart.
  const installEnvTimer = sweepEvery("install settings", INSTALL_ENV_MS, async () => {
    const changed = await applyInstallEnv(repo);
    if (changed.length) log.info("settings changed in the panel are now in force here", { settings: changed });
  });

  // The sweeps in server-sweeps.ts reach the game through this: the same client and connect as
  // everything else here, handed in so a test can put a fake game in its place.
  const serverSweeps: ServerSweepDeps = {
    repo,
    log,
    clientFor: (server) => {
      const client = gameClientFor(server);
      return {
        connect: () => connectGameClient(client, server),
        execute: (command, params) => client.execute(command, params),
        readState: (kind) => client.readState(kind),
        disconnect: () => client.disconnect(),
      };
    },
  };

  // Expire VIPs + console admins on schedule (the game knows only permanent entries — we own expiry).
  const vipSweep = sweepEvery("VIP/console-admin sweep", VIP_SWEEP_MS, async () => {
    await sweepExpiredVips(repo);
    await resumeLapsedVipPauses(serverSweeps);
    await sweepExpiredConsoleAdmins(serverSweeps);
    await sweepLapsedWatches(repo);
    await sweepExpiredRequests(repo);
    await repo.heartbeats.upsert({ name: "vip_sweep", status: "running", detail: { intervalMs: VIP_SWEEP_MS } }).catch(() => {});
  });

  // Group VIP perks: membership → permanent VIP holds, with timed VIP frozen beneath them.
  const groupPerks = sweepEvery("group perks", GROUP_PERK_MS, singleFlight(async () => {
    const notes = await reconcileGroupPerks(repo);
    await repo.heartbeats.upsert({ name: "group_perks", status: "running", detail: { intervalMs: GROUP_PERK_MS, notes } }).catch(() => {});
  }));

  // Groups linked to a role in the COMMUNITY Discord (players live there, not in the staff one —
  // which stands in when no community server is configured): whoever holds the role, with a
  // linked game account, is listed; whoever the sync listed and lost it is not.
  const groupRoles = sweepEvery("group discord roles", GROUP_ROLE_SYNC_MS, singleFlight(async () => {
    const guildId = (await repo.appConfig.get().catch(() => null))?.communityGuildId || discordGuildId();
    if (!discordToken() || !guildId) return;
    const r = await syncGroupRoles(repo, { token: discordToken(), guildId });
    if (r.added || r.removed || r.skipped || r.missingRoles.length) log.info("group discord role sync", { ...r });
    await repo.heartbeats.upsert({ name: "group_role_sync", status: "running", detail: { intervalMs: GROUP_ROLE_SYNC_MS, ...r } }).catch(() => {});
  }));

  // The reconcilers' fixes were deploy flags once. An install that still sets one is told where
  // the switch went, rather than left wondering why its reconciler only reports now.
  for (const flag of ["BAN_RECONCILE_APPLY", "VIP_RECONCILE_APPLY"]) {
    if (process.env[flag]) log.warn(`${flag} is no longer read — switch "Fix what it finds" on per server in the app (Administration → Connections → Automation)`);
  }
  // Ban reconciliation: decisions vs each server's live ban list. Dry-run unless that server's fix
  // is switched on (see banReconcileSweep). The signature map lives across ticks so standing
  // findings report once.
  const banSyncSig = new Map<string, string>();
  const banStuck = { apply: new StuckWrites(), lift: new StuckWrites() };
  const banSync = sweepEvery("ban reconcile", BAN_RECONCILE_MS, async () => {
    const fixing = await banReconcileSweep(repo, banSyncSig, banStuck);
    await repo.heartbeats.upsert({ name: "ban_sync", status: "running", detail: { intervalMs: BAN_RECONCILE_MS, fixing: fixing.length ? fixing.join(", ") : "none — report only" } }).catch(() => {});
  });

  // VIP reconciliation: grants vs each server's live VIP list — the check that catches a wiped or
  // never-landed VIP list (the game answering an empty list while the table holds dozens of live
  // grants). Same cadence and same arming discipline as the ban reconciler.
  const vipSyncSig = new Map<string, string>();
  const vipStuck = { apply: new StuckWrites(), remove: new StuckWrites() };
  const vipSync = sweepEvery("vip reconcile", BAN_RECONCILE_MS, async () => {
    const fixing = await vipReconcileSweep(repo, vipSyncSig, vipStuck);
    await repo.heartbeats.upsert({ name: "vip_sync", status: "running", detail: { intervalMs: BAN_RECONCILE_MS, fixing: fixing.length ? fixing.join(", ") : "none — report only" } }).catch(() => {});
  });

  // Unread-notice nudge (Discord): a slow check is plenty — the trigger is measured in hours.
  const nudgeTimer = sweepEvery("announcement nudge", ANNOUNCE_NUDGE_MS, () => nudgeUnreadAnnouncements(repo));

  // Staff-role resync from Discord: sign-in projects Discord roles onto panel roles once, this
  // keeps them true BETWEEN sign-ins — a role granted, revoked, or a member removed in Discord
  // lands here within one cadence, live sessions included (grants are recomputed per request).
  const roleSyncTimer = sweepEvery("discord role sync", DISCORD_ROLE_SYNC_MS, async () => {
    if (!discordToken() || !discordGuildId()) return;
    const r = await syncDiscordRoles(repo, { token: discordToken(), guildId: discordGuildId() });
    if (r.changed || r.cleared || r.errors) log.info("discord role sync", { ...r });
    await repo.heartbeats.upsert({ name: "discord_role_sync", status: "running", detail: { intervalMs: DISCORD_ROLE_SYNC_MS, ...r } }).catch(() => {});
  });

  // Slow CRCON backup pulls: drive any job still marked `running`, resuming across restarts. One
  // driver per job (idempotent); each pull is self-throttled through the CrconClient.
  const importDrivers = new Map<string, Promise<void>>();
  const importScan = sweepEvery("crcon import scan", CRCON_IMPORT_SCAN_MS, () => driveImportJobs(repo, importDrivers));

  // Payout event boundaries: open/close each scheduled window when its hard time or match
  // boundary arrives (the policy is @app/payout's, shared with the API's resolve-on-read — this
  // timer only makes the states move without anyone looking at the panel). A late tick loses
  // nothing: presence is recorded by sessions regardless, and boundaries resolve to where they
  // were scheduled, not to when the sweep ran.
  const payoutEventSweep = sweepEvery("payout event sweep", PAYOUT_EVENT_SWEEP_MS, async () => {
    const r = await sweepPayoutEvents(repo);
    if (r.opened || r.closed) log.info("payout events resolved", { ...r });
    await applyEventRotations(serverSweeps);
  });

  // The self-sending events post. Checked on a slow cadence because the trigger is a time of DAY:
  // a few minutes' granularity is invisible to a reader, and the date latch means a tick that
  // arrives late still sends that day's post rather than skipping the week.
  const eventsPostTimer = sweepEvery("events post", EVENTS_POST_MS, () => postEventsList(repo));

  // Weapon-class records: fold finished rounds' kill streams into per-class counts, newest first.
  const classRollupTimer = sweepEvery("weapon rollup sweep", CLASS_ROLLUP_MS, () =>
    sweepWeaponRollups(repo, CLASS_ROLLUP_BATCH, (game) => (w) => classifyWeapon(getGame(game)?.descriptor, w)));

  // "Keep this layout for the next N plays": count each new round of the map, and at zero send
  // RemoveSectorLayout — the expiry the game itself does not have (layout-expiry.ts has the
  // rules). DB-only until a countdown actually reaches zero; the game is dialed only to clear.
  const layoutExpiryTimer = sweepEvery("layout expiry sweep", LAYOUT_EXPIRY_MS, () => runLayoutExpiryTick({
    repo,
    log,
    clientFor: (server) => {
      const client = gameClientFor(server);
      return {
        connect: () => connectGameClient(client, server),
        execute: (command, params) => client.execute(command, params),
        disconnect: () => client.disconnect(),
      };
    },
  }));

  // The removed objective presets ("Map points") may have left a Vietnam layout on a game server,
  // with a row the only record of what to put back (preset-leftovers.ts). Nothing writes rows any
  // more, so once a sweep finds none the timer is stopped for good.
  const presetLeftovers = { failures: new QuietFailures() };
  let presetLeftoversTimer: NodeJS.Timeout | null = null;
  presetLeftoversTimer = sweepEvery("objective preset leftovers", PRESET_LEFTOVERS_MS, singleFlight(async () => {
    const done = await runPresetLeftovers({
      repo, log, failures: presetLeftovers.failures, now: () => Date.now(),
      clientFor: (server) => {
        const client = gameClientFor(server);
        return {
          connect: () => connectGameClient(client, server),
          execute: (command, params) => client.execute(command, params),
          disconnect: () => client.disconnect(),
        };
      },
    });
    if (done && presetLeftoversTimer) { clearInterval(presetLeftoversTimer); presetLeftoversTimer = null; }
  }));

  /*
   * Nightly automatic full backup — the worker's half of Admin → Backup.
   *
   * The sweep ticks often and the PLANNER decides (auto-backup.ts): due once per community day,
   * at the configured hour, Postgres installs only. The archive is the same restorable shape the
   * manual button writes, into the same host-mounted folder, under its own auto-backup-* prefix —
   * and rotation deletes only that prefix, because a manual full-backup-* was made deliberately.
   * whilePaused (via sweepEvery) keeps this out of a restore window: archiving a database that a
   * restore is mid-refill would faithfully preserve the half-loaded state.
   *
   * Failure is the loud path. A backup that silently stops running is discovered on the day it
   * was needed, which is the one day it cannot be fixed — so a failing run warns through the
   * quiet-failure tracker (once, then repeated sparsely, with a recovery line) AND writes an
   * audit row on the first failure of a streak, where staff actually look.
   */
  const backupDir = process.env.BACKUP_DIR || "/data/backups";
  const backupSweep = sweepEvery("auto backup", AUTO_BACKUP_SWEEP_MS, async () => {
    const cfg = await repo.appConfig.get();
    const files = await readdir(backupDir).catch(() => [] as string[]);
    const plan = planAutoBackup({
      enabled: cfg.autoBackupEnabled, supported: repo.dataPort.supported,
      hour: cfg.autoBackupHour, keep: cfg.autoBackupKeep, timezone: cfg.timezone,
      nowMs: Date.now(), files,
    });
    if (plan.due) {
      const name = autoBackupFileName();
      try {
        await mkdir(backupDir, { recursive: true });
        const result = await repo.dataPort.export(allDataGroups(), `${backupDir}/${name}`);
        const bytes = statSync(`${backupDir}/${name}`).size;
        log.info("automatic backup written", { name, rows: result.rows, bytes });
        await repo.audit.create({
          actorUserId: null, actorName: "auto-backup", action: "data.backup",
          targetType: "setting", targetId: "data-port", targetName: name,
          summary: `wrote the nightly automatic backup ${name} (${result.rows.toLocaleString()} rows, ${(bytes / 1048576).toFixed(1)} MB)`,
          data: { name, rows: result.rows, bytes, auto: true },
        }).catch(() => {});
        const ok = quiet.ok("auto-backup");
        if (ok.recovered && ok.runs > 1) log.info("automatic backups running again", { failedRuns: ok.runs, downFor: forDuration(ok.sinceMs) });
      } catch (err) {
        // A half-written archive is worse than none: it LOOKS like a backup and restores a
        // truncated database. Remove it so the folder only ever holds archives that finished.
        await unlink(`${backupDir}/${name}`).catch(() => {});
        const v = quiet.fail("auto-backup");
        if (v.speak) log.warn(`automatic backup failed ${v.runs > 1 ? `(${v.runs} runs, ${forDuration(v.sinceMs)}) ` : ""}— ${(err as Error).message}`);
        if (v.runs === 1) {
          await repo.audit.create({
            actorUserId: null, actorName: "auto-backup", action: "data.backup_failed",
            targetType: "setting", targetId: "data-port",
            summary: `the nightly automatic backup FAILED: ${(err as Error).message}`,
            data: { error: (err as Error).message },
          }).catch(() => {});
        }
        return; // keep the old archives when tonight's could not be written
      }
    }
    for (const stale of plan.prune) {
      await unlink(`${backupDir}/${stale}`).catch(() => {});
      log.info("rotated out an old automatic backup", { name: stale });
    }
  });

  // Liveness heartbeat for the System view.
  const heartbeat = setInterval(() => void beat(repo, servers.size), 20_000);
  void beat(repo, servers.size);

  const shutdown = () => {
    servers.stopAll();
    clearInterval(rescan);
    clearInterval(vipSweep);
    clearInterval(banSync);
    clearInterval(vipSync);
    clearInterval(groupPerks);
    clearInterval(groupRoles);
    clearInterval(importScan);
    clearInterval(payoutEventSweep);
    clearInterval(backupSweep);
    clearInterval(eventsPostTimer);
    clearInterval(classRollupTimer);
    clearInterval(layoutExpiryTimer);
    if (presetLeftoversTimer) clearInterval(presetLeftoversTimer);
    clearInterval(heartbeat);
    clearInterval(nudgeTimer);
    clearInterval(roleSyncTimer);
    clearInterval(installEnvTimer);
    void repo.heartbeats.upsert({ name: "ingestion", status: "stopped", detail: {} }).catch(() => {});
    log.info("shutting down");
    void bus.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // This process holds every server's RCON connection and the whole ingest path, so a fault in one
  // server's loop takes all of them down. Exiting is still correct — a supervised restart re-opens
  // every connection cleanly — but the heartbeat must say we stopped, or the System view reports a
  // worker that is "running" and silent, which is the hardest failure to diagnose.
  installCrashHandlers(log, {
    beforeExit: async () => {
      servers.stopAll();
      await repo.heartbeats.upsert({ name: "ingestion", status: "stopped", detail: { reason: "crashed" } }).catch(() => {});
      await bus.close().catch(() => {});
    },
  });
}

main().catch((err) => {
  log.error("fatal", { err });
  process.exit(1);
});
