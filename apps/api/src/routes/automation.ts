/**
 * The per-server automations: seeding rewards, rotating broadcasts, and Auto settings (profiles, templates).
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { APP_SETTINGS, AUTOSETTINGS_DEFAULTS, BROADCAST_DEFAULTS, GAME_REWARDS_DEFAULTS, mergeGameRewards, WELCOME_DEFAULTS, WELCOME_INTERVAL_MIN_SEC, WELCOME_INTERVAL_MAX_SEC, type WelcomeConfigPatch, FEATURE_PRESETS, getFeaturePreset, SEEDING_DEFAULTS, SEEDING_REWARD_KEYS, composeSeedingAnnounce, presetGameMismatch, seedCycleReplayRefusal, seedCycleRetryable, hasPlaceholders, serverWideTextError, type AutoSettingsProfile } from "@app/db";
import { matchMinutesSince, resolveProfile, type ScheduleSpec } from "@app/schedule";
import { containMapCatalog, describeCoverage, describeMap, layerZoneKey, layoutZonePaint, learnedLayoutOf, zoneKeyOf } from "@app/maps";
import { classifyWeapon, getGame } from "@app/games";
import { errors } from "@app/shared";
import { ObserveModeViolation, messageEveryone } from "@app/rcon-core";
import { configFieldsFor, connectGameClient, decommissionLocked, gameClientFor, parseAutoSettings, parseBroadcastBody, parseSeedingBody, requirePrincipal, route, ruleKeyMissing, seedRewardRefusal, sendForbidden, serverRoute, type Route } from "./kit.js";
import { rendererFor } from "../render-text.js";
import { livePayouts, parseGameRewardsBody } from "../game-rewards-body.js";
import { seedingAuditFor } from "../seeding-audit.js";
import { priorOf } from "../audit-changes.js";
import type { AppContext } from "../context.js";

/** The key a saved "Player rules" setup needs on `serverId` beyond rule editing, or null: each of
 *  its rules is checked as if saved there by hand (see ruleKeyMissing). */
function setupKeyMissing(grants: Parameters<typeof can>[0], config: unknown, serverId: string): string | null {
  const rules = (config as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return null;
  for (const r of rules as { action?: unknown; escalateActions?: unknown }[]) {
    const missing = ruleKeyMissing(grants, {
      action: String(r?.action ?? ""),
      escalateActions: Array.isArray(r?.escalateActions) ? (r.escalateActions as unknown[]).map(String) : [],
      serverId,
    });
    if (missing) return missing;
  }
  return null;
}

/** `config` without the seed reward's fields — the config as a reader without Seeding rewards sees it. */
function withoutReward<T extends object>(config: T): Partial<T> {
  const hidden = new Set<string>(SEEDING_REWARD_KEYS);
  return Object.fromEntries(Object.entries(config).filter(([k]) => !hidden.has(k))) as Partial<T>;
}

/**
 * Would writing `patch` change the seed reward `current` has? Both sides go through the save's own
 * parser first, so a field restated as it stands compares equal however it was spelled (a blank
 * note stored as nothing, a number sent as text). A side that will not parse counts as a change.
 */
function rewardChanges(current: object, patch: object): boolean {
  const pick = (from: object) => {
    const out: Record<string, unknown> = {};
    for (const k of SEEDING_REWARD_KEYS) {
      const v = (from as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const asked = pick(patch);
  if (!Object.keys(asked).length) return false;
  const want = parseSeedingBody(asked, new Set());
  const have = parseSeedingBody({ ...pick(current), rewardBridge: (current as { rewardBridge?: unknown }).rewardBridge ?? [] }, new Set());
  if ("error" in want || "error" in have) return true;
  const was = have.value as Record<string, unknown>;
  return Object.entries(want.value).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(was[k]));
}

/*
 * A profile that applies a saved setup does, on a schedule, what the setup's own Apply button does —
 * so it answers to the same keys: that feature's own write here, and for a rules setup carrying a
 * VIP rule, the VIP grant power here too. Only a choice that ADDS or CHANGES one is asked about; one
 * already standing keeps standing on whoever set it, so holding fewer keys than a colleague never
 * locks you out of the rest of the profile editor. The key missing first, or null.
 */
async function presetKeyMissing(ctx: AppContext, grants: Parameters<typeof can>[0], serverId: string, profiles: AutoSettingsProfile[]): Promise<string | null> {
  const stored = await ctx.repo.autosettings.getConfig(serverId).catch(() => null);
  const standing = new Set((stored?.profiles ?? []).flatMap((pr) => Object.entries(pr.settings ?? {}).filter(([k]) => k.startsWith("preset:")).map(([k, v]) => `${k}=${String(v)}`)));
  for (const pr of profiles) {
    for (const [field, v] of Object.entries(pr.settings ?? {})) {
      if (!field.startsWith("preset:") || standing.has(`${field}=${String(v)}`)) continue;
      const def = getFeaturePreset(field.slice("preset:".length));
      if (!def) continue; // the parser refused unknown features when the profile was saved
      if (!can(grants, def.capability, "write", { serverId })) return def.capability;
      // A seeding setup carries the seed reward, and a profile applies it whenever it comes round —
      // over whatever reward the server has by then — so one that carries any of it takes the
      // reward's own permission here, whatever the server pays today.
      if (def.feature === "seeding" && !can(grants, "seeding.rewards", "write", { serverId })) {
        const setup = await ctx.repo.featurePresets.get("seeding", String(v)).catch(() => null);
        if (setup && SEEDING_REWARD_KEYS.some((k) => (setup.config as Record<string, unknown>)[k] !== undefined)) return "seeding.rewards";
      }
      if (def.feature === "rules") {
        const setup = await ctx.repo.featurePresets.get("rules", String(v)).catch(() => null);
        const missing = setup ? setupKeyMissing(grants, setup.config, serverId) : null;
        if (missing) return missing;
      }
    }
  }
  return null;
}

export const automationRoutes: Route[] = [
  // --- Seeding enforcement + seed-reward config (per server, requires admin.moderation) ---
  // Returns the stored config merged over SEEDING_DEFAULTS so the editor always has a full object,
  // plus the game's role labels so the UI can render the disallowed-role picker game-agnostically.
  serverRoute("GET", "/api/servers/:id/seeding", "seeding.config", "read", async ({ res, ctx, params, p, server }) => {
    const stored = await ctx.repo.seeding.getConfig(params.id!);
    const config = stored ?? { serverId: params.id!, ...SEEDING_DEFAULTS, updatedAt: new Date(0).toISOString() };
    /*
     * The ground rules — the position-driven seeding fields — answer to the rules permission
     * (admin.moderation), asked exactly as the Map zones page they are configured on asks it: a
     * capability the catalog keeps global, so held anywhere is held. The panel shows them only
     * there, and the wire matches: to a seeding-config reader without it the config is simply
     * complete without these fields, and (below) their PUT cannot touch them. The greeting preview
     * keeps its containment line either way — that line is broadcast to every player in game.
     */
    const seesContainment = canAnywhere(p.grants, "admin.moderation", "read");
    const descriptor = getGame(server.game)?.descriptor;
    const roles = descriptor?.roles ?? {};
    // The weapon-class catalogue, so the panel renders class CHIPS (like the role picker) instead
    // of asking staff to type weapon names. Ids are what the config stores; labels are for people.
    const weaponClasses = (descriptor?.weaponClasses ?? []).map((c) => ({ id: c.id, label: c.label }));
    // The INDIVIDUAL weapon table, classified here so the panel can group the picker by class
    // without mirroring the pattern-matching rules; and the commander kill-abilities, which drive
    // their own section. Both empty for games without a verified table (the picker then falls
    // back to chips + free text).
    /*
     * The static catalogue UNIONED with every weapon this server's own kill logs have recorded
     * (the match weapon rollup — verbatim log spellings). The catalogue alone goes stale the day
     * the game patches: a renamed or brand-new weapon could be neither picked nor validated until
     * someone re-derived the table. The logs cannot go stale — a weapon that killed someone here
     * is spelled exactly as a restriction must spell it — so an update's additions appear in this
     * picker on their own after their first kills land. The catalogue still matters for the
     * weapons nobody has fired yet (and for a fresh install with no history).
     */
    const catalogNames = descriptor?.weaponCatalog ?? [];
    const inCatalog = new Set(catalogNames.map((n) => n.toUpperCase()));
    const seenHere = (await ctx.repo.matches.weaponSummary(params.id!, 500).catch(() => []))
      .filter((r) => r.weapon && !inCatalog.has(r.weapon.toUpperCase()));
    const weapons = [
      ...catalogNames.map((name) => ({ name, classId: classifyWeapon(descriptor, name).id })),
      ...seenHere.map((r) => ({ name: r.weapon, classId: r.classId || classifyWeapon(descriptor, r.weapon).id, fromLogs: true })),
    ];
    const commanderAbilities = descriptor?.commanderAbilities ?? [];
    // Exactly what a joining player will be sent, composed by the same code the worker sends with
    // (@app/db) — so the editor shows the real message rather than a second implementation's guess.
    const announcePreview = composeSeedingAnnounce(config, {
      role: (r) => roles[r] ?? `role ${r}`,
      weaponClass: (id) => weaponClasses.find((c) => c.id === id)?.label ?? id,
    });
    // The containment editor's map list: zone key + the label people read, per game. The key is
    // what the worker computes from the live session, so drawing and enforcing cannot disagree.
    const containMaps = seesContainment ? containMapCatalog(server.game) : undefined;
    let outConfig: object = config;
    if (!seesContainment) {
      const { containEnabled: _ce, containAutoEnabled: _ca, positionalEnabled: _pos, containGraceSec: _cg, containMaxPlayers: _cm, containNotice: _cn, containZones: _cz, paceEnabled: _pe, paceUnlockMinutes: _pu, paceNotice: _pn, layoutLearnEnabled: _ll, ...rest } = config;
      outConfig = rest;
    }
    // The seed reward answers to its own permission on this server (Seeding rewards, carved off
    // this one), and reads the same way: without it, the config is complete without the reward.
    if (!can(p.grants, "seeding.rewards", "read", { serverId: params.id! })) outConfig = withoutReward(outConfig);
    // Each LAYER's learned attack geometry, with the zone paint it implies — the ground rules'
    // painter shows it as the layer's auto zone, or offers it as a one-click prefill. Votes that
    // do not yet agree enough come back as `learning`. `autoZone`: auto zones fences this layer
    // from it (warfare only, as the worker does) wherever no paint covers the layer — its own,
    // or its `family`'s.
    const learnedLayouts = seesContainment
      ? Object.fromEntries((await ctx.repo.mapLayouts.list().catch(() => [])).map((row) => {
          const learned = learnedLayoutOf(row);
          const votes = row.xNeg + row.xPos + row.yNeg + row.yPos;
          return [layerZoneKey(row.mapId)!, learned
            ? { status: "learned", axis: learned.axis, alliesDir: learned.alliesDir, rounds: votes, agree: learned.agree, prefill: layoutZonePaint(learned),
                autoZone: describeMap(row.mapId).mode === "warfare", family: zoneKeyOf(row.mapId) }
            : { status: "learning", rounds: votes }];
        }))
      : undefined;
    sendJson(res, 200, { config: outConfig, roles, weaponClasses, weapons, commanderAbilities, announcePreview, ...(containMaps ? { containMaps } : {}), ...(learnedLayouts ? { learnedLayouts } : {}), configured: stored !== null });
  }),

  serverRoute("PUT", "/api/servers/:id/seeding", "seeding.config", "write", async ({ req, res, ctx, params, p, server }) => {
    const body = await readJsonBody(req);
    const descriptor = getGame(server.game)?.descriptor;
    const validRoles = new Set(Object.keys(descriptor?.roles ?? {}).map(Number));
    const validWeaponClasses = new Set((descriptor?.weaponClasses ?? []).map((c) => c.id));
    // Same union as the GET: a name is a valid exact-match restriction if the catalogue knows it
    // OR this server's own logs have recorded it — never a free-typed guess.
    const seenNames = (await ctx.repo.matches.weaponSummary(params.id!, 500).catch(() => [])).map((r) => r.weapon.toUpperCase());
    const validWeaponNames = new Set([...(descriptor?.weaponCatalog ?? []).map((n) => n.toUpperCase()), ...seenNames]);
    const validAbilities = new Set((descriptor?.commanderAbilities ?? []).map((a) => a.toUpperCase()));
    const parsed = parseSeedingBody(body, validRoles, validWeaponClasses, validWeaponNames, validAbilities);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    // The GET above withholds the ground rules from staff without the rules permission; the
    // write half matches, a step up — changing them takes that permission at write, as painting a
    // zone set does. Those keys are dropped from the patch rather than refused: the Seeding tab
    // never sends them, so only a stale or hand-made request carries them, and its other fields
    // still save.
    if (!canAnywhere(p.grants, "admin.moderation", "write")) {
      delete parsed.value.containEnabled;
      delete parsed.value.containAutoEnabled;
      delete parsed.value.positionalEnabled;
      delete parsed.value.paceEnabled;
      delete parsed.value.paceUnlockMinutes;
      delete parsed.value.paceNotice;
      delete parsed.value.layoutLearnEnabled;
      delete parsed.value.containGraceSec;
      delete parsed.value.containMaxPlayers;
      delete parsed.value.containNotice;
      delete parsed.value.containZones;
    }
    const current = (await ctx.repo.seeding.getConfig(params.id!)) ?? SEEDING_DEFAULTS;
    /*
     * The seed reward answers to Seeding rewards at write, on this server. The tab sends the whole
     * config on every save, the reward included for whoever may read it, so a reward field is judged
     * by whether this save CHANGES it: restated as it stands it saves with the rest, changed it takes
     * the permission. A reader without it is never sent the reward, so their saves carry none of it.
     */
    if (!can(p.grants, "seeding.rewards", "write", { serverId: params.id! }) && rewardChanges(current, parsed.value)) {
      return sendForbidden(res, "seeding.rewards", "write");
    }
    // Judged on what the config WILL be, not on what this patch says: the reward's two halves are
    // set from different fields (and often in different saves), so only the merge is wrong or right.
    const refusal = seedRewardRefusal({ ...current, ...parsed.value });
    if (refusal) return sendError(res, 400, refusal);
    /*
     * The bridge pays VIP on OTHER servers, so each target answers to vip.grant THERE, never to
     * seeding.config here — the trigger rule, restated: automation must not do what its author
     * could not do by hand. Judged only for rows this save ADDS or CHANGES hours on: removing a
     * stop narrows the reward and needs nothing, and an untouched row keeps standing on the
     * authority of whoever saved it, so a colleague can still edit the warn message.
     */
    if (parsed.value.rewardBridge) {
      const standing = new Map((current.rewardBridge ?? []).map((t) => [t.serverId, t.hours]));
      for (const t of parsed.value.rewardBridge) {
        if (t.serverId === params.id!) return sendError(res, 400, "this server's own reward hours already cover it — the bridge is for OTHER servers");
        /*
         * Every target check below is for rows this save ADDS or CHANGES. A stop restated exactly
         * as it stands keeps the authority of whoever saved it — including one whose target has
         * since retired or vanished: the panel sends the whole config on every save, so refusing
         * a standing row here would brick the entire seeding screen over a stop the saver never
         * touched, until somebody hunts down a row the picker cannot even name any more. The
         * WORKER is where a dead stop is handled: skipped at payout, reason on every receipt.
         */
        if (standing.get(t.serverId) === t.hours) continue;
        const target = await ctx.repo.servers.findById(t.serverId);
        // Unknown and decommissioned answer identically: for everyone but the setup account a
        // decommissioned server IS not a server here.
        if (!target || await decommissionLocked(ctx, p, target)) return sendError(res, 400, "a bridge target is not a server here — pick it from the list again");
        if (target.retiredAt) return sendError(res, 400, `${target.name} is retired — a parked server takes no new payouts`);
        if (!can(p.grants, "vip.grant", "write", { serverId: t.serverId })) return sendForbidden(res, "vip.grant", "write");
      }
    }
    // The trail is read under audit.trail, not the rules permission the ground rules answer to —
    // so the audited patch carries the Seeding tab's fields only. The row still records that the
    // config changed, by whom and when; what the ground rules hold is read on Map zones.
    const { containEnabled: _pce, containAutoEnabled: _pca, positionalEnabled: _ppos, containGraceSec: _pcg, containMaxPlayers: _pcm, containNotice: _pcn, containZones: _pcz, paceEnabled: _ppe, paceUnlockMinutes: _ppu, paceNotice: _ppn, layoutLearnEnabled: _pll, ...auditedPatch } = parsed.value;
    // What the save replaces, of those same fields, so the trail can say exactly what changed.
    const before = priorOf(current, auditedPatch, SEEDING_DEFAULTS);
    const config = await ctx.repo.seeding.upsertConfig(params.id!, parsed.value);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "seeding.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated seeding config for ${server.name}${config.enabled ? "" : " (disabled)"}${config.dryRun ? " (dry-run)" : ""}`,
      data: { patch: auditedPatch, before },
    });
    // The echo obeys the same rule as the GET: the store's row carries the ground rules whoever
    // wrote, but they only ride back to holders of the rules permission.
    let outConfig: object = config;
    if (!canAnywhere(p.grants, "admin.moderation", "read")) {
      const { containEnabled: _ce, containAutoEnabled: _ca, positionalEnabled: _pos, containGraceSec: _cg, containMaxPlayers: _cm, containNotice: _cn, containZones: _cz, paceEnabled: _pe, paceUnlockMinutes: _pu, paceNotice: _pn, layoutLearnEnabled: _ll, ...rest } = config;
      outConfig = rest;
    }
    if (!can(p.grants, "seeding.rewards", "read", { serverId: params.id! })) outConfig = withoutReward(outConfig);
    sendJson(res, 200, { config: outConfig });
  }),

  // Live seeding status for the UI: current phase/counts (from the worker) + how many players are
  // accruing seed time this cycle. Read-only; visible to anyone who can view the server.
  route("GET", "/api/servers/:id/seeding/status", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "server.view", "read", { serverId: params.id })) return sendForbidden(res, "server.view", "read");
    const [state, progress, config, lastCycle] = await Promise.all([
      ctx.repo.seeding.getState(params.id!),
      ctx.repo.seeding.listProgress(params.id!),
      ctx.repo.seeding.getConfig(params.id!),
      ctx.repo.seeding.getLastCycle(params.id!),
    ]);
    // A summary of the archived cycle only — enough for the "pay last seed" button to know
    // whether there is anything to pay; the entries themselves stay server-side.
    const need = Math.max(0, config?.minSeedMinutes ?? 0) * 60;
    const cycleSummary = lastCycle
      ? { endedAt: lastCycle.endedAt, rewarded: lastCycle.rewarded, qualifying: lastCycle.entries.filter((e) => e.seconds >= need).length, refusal: seedCycleReplayRefusal(lastCycle), owed: seedCycleRetryable(lastCycle).length }
      : null;
    sendJson(res, 200, { state, progressCount: progress.length, enabled: config?.enabled ?? false, dryRun: config?.dryRun ?? true, lastCycle: cycleSummary });
  }),

  /*
   * Recent seed payouts, per server — the receipts, read where the reward is configured instead
   * of dug out of the admin trail. Every seeder of every round has ONE row (paid, partly paid,
   * skipped, or failed with the error), grouped here by round. Newer receipts carry their round
   * id; older ones are grouped by time instead (a round's rows are written within seconds).
   */
  serverRoute("GET", "/api/servers/:id/seeding/payouts", "seeding.rewards", "read", async ({ res, ctx, params }) => {
    const rows = await ctx.repo.audit.list({ serverIds: [params.id!], action: "seed.reward", limit: 300 });
    type Receipt = { playerId: string | null; name: string | null; summary: string; outcome: "paid" | "partial" | "failed" | "dryRun"; dryRun: boolean };
    const rounds: { round: string; at: string; manual: boolean; dryRun: boolean; receipts: Receipt[] }[] = [];
    for (const r of rows) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const dryRun = d.dryRun === true;
      // A bridge receipt written on THIS server for a round seeded elsewhere is that round's
      // business, not a seeder of ours — it carries `bridgeFrom` and stays out of the list.
      if (d.bridgeFrom) continue;
      const failed = typeof d.failed === "string" || typeof d.vipFailed === "string";
      const partial = !failed && (typeof d.pointsSkipped === "string" || d.pointsCapped === true);
      const receipt: Receipt = {
        playerId: r.targetId, name: r.targetName, summary: r.summary,
        outcome: dryRun ? "dryRun" : failed ? "failed" : partial ? "partial" : "paid", dryRun,
      };
      const key = typeof d.round === "string" ? d.round : null;
      // Keyed rounds merge by id — a retry's receipts carry the ORIGINAL round's id and arrive
      // later, so the round is found wherever it sits. Unkeyed (older) receipts group by time:
      // a round's rows are written back to back.
      const last = rounds[rounds.length - 1];
      const round = key
        ? rounds.find((x) => x.round === key)
        : (last && last.round.startsWith("t:") && Math.abs(Date.parse(last.at) - Date.parse(r.ts)) < 5 * 60_000 ? last : undefined);
      if (!round) {
        rounds.push({ round: key ?? `t:${r.ts}`, at: r.ts, manual: d.manual === true, dryRun, receipts: [receipt] });
        continue;
      }
      // The round is dated by its ORIGINAL receipts, not the retry that reached it first.
      if (Date.parse(r.ts) < Date.parse(round.at)) round.at = r.ts;
      // Rows arrive newest first, so a player already listed has a NEWER receipt — a retry that
      // paid what the round had failed. Their current state is the one shown.
      if (receipt.playerId && round.receipts.some((x) => x.playerId === receipt.playerId)) continue;
      round.receipts.push(receipt);
      if (d.manual === true) round.manual = true;
    }
    sendJson(res, 200, { rounds: rounds.slice(0, 20) });
  }),

  /*
   * PAY LAST SEED — replay the archived cycle's reward round, for the payout that never fired
   * (a worker restart across the go-live line, a server that drained unwatched). The API only
   * QUEUES it; the worker pays on its next tick through the exact machinery a live round uses,
   * so the receipts, absorb rules and bridge stops are the real ones. Guarded three ways: an
   * already-paid cycle is refused (a replay is for the MISSED payout, not a bonus button), and
   * the requester must hold the keys the payment turns — vip.grant HERE for the VIP half,
   * economy.balances for the points half — because a queued automation must not do what its
   * author could not do by hand.
   */
  serverRoute("POST", "/api/servers/:id/seeding/pay-last", "seeding.rewards", "write", async ({ res, ctx, params, p, server }) => {
    const config = await ctx.repo.seeding.getConfig(params.id!);
    if (!config || !config.enabled) return sendError(res, 400, "seeding automation is not enabled on this server, so there is no worker to run the payout");
    // A replay under dry-run (or on an observe-mode server) only SIMULATES — it would consume the
    // request and grant nothing while the button said "queued". Refused up front, with the fix.
    if (config.dryRun) return sendError(res, 400, "seeding dry-run is on, so the replay would only be simulated — switch dry-run off first");
    if (server.engagementMode !== "active") return sendError(res, 400, "this server is in observe mode, so the replay would only be simulated — make it active first");
    const hours = Math.max(0, config.rewardHours);
    const points = Math.max(0, config.rewardPoints ?? 0);
    if (!config.rewardEnabled || (hours <= 0 && points <= 0)) return sendError(res, 400, "the seed reward is off (or gives nothing) — there is nothing to pay");
    if (hours > 0 && !can(p.grants, "vip.grant", "write", { serverId: params.id })) return sendForbidden(res, "vip.grant", "write");
    if (points > 0 && !canAnywhere(p.grants, "economy.balances", "write")) return sendForbidden(res, "economy.balances", "write");
    const cycle = await ctx.repo.seeding.getLastCycle(params.id!);
    const refusal = seedCycleReplayRefusal(cycle);
    // A round that PAID but did not finish paying everyone is retried — its owed parts only.
    const owed = seedCycleRetryable(cycle);
    if (refusal && cycle && owed.length) {
      await ctx.repo.seeding.requestPay(params.id!);
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "seed.payLast",
        targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
        summary: `queued a retry of the ${owed.length} seeder(s) the last seed round on ${server.name} did not finish paying`,
        data: { endedAt: cycle.endedAt, retry: true, owed: owed.map((f) => ({ playerId: f.playerId, needVip: f.needVip, needPoints: f.needPoints, needBridge: f.needBridge })) },
      });
      return sendJson(res, 200, { queued: true, mode: "retry", qualifying: owed.length, endedAt: cycle.endedAt });
    }
    if (refusal || !cycle) return sendError(res, 400, refusal ?? "no finished seed cycle on record");
    const qualifying = cycle.entries.filter((e) => e.seconds >= config.minSeedMinutes * 60).length;
    if (qualifying === 0) return sendError(res, 400, "nobody in the last cycle met the minimum seed time");
    await ctx.repo.seeding.requestPay(params.id!);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "seed.payLast",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `queued the missed seed payout on ${server.name} — ${qualifying} qualifying seeder(s) from the cycle that ended ${cycle.endedAt}`,
      data: { endedAt: cycle.endedAt, qualifying, hours, points },
    });
    sendJson(res, 200, { queued: true, mode: "full", qualifying, endedAt: cycle.endedAt });
  }),

  // --- Broadcast: rotating auto-messages (config) + one-shot "message the whole server" ---
  // Config read/write is gated by server.config (it's server automation); send-now is a messaging
  // action, gated by action.message like the per-player message action.
  serverRoute("GET", "/api/servers/:id/broadcast", "broadcast.config", "read", async ({ res, ctx, params }) => {
    const stored = await ctx.repo.broadcast.getConfig(params.id!);
    const config = stored ?? { serverId: params.id!, ...BROADCAST_DEFAULTS, updatedAt: new Date(0).toISOString() };
    sendJson(res, 200, { config, configured: stored !== null });
  }),

  serverRoute("PUT", "/api/servers/:id/broadcast", "broadcast.config", "write", async ({ req, res, ctx, params, p, server }) => {
    const parsed = parseBroadcastBody(await readJsonBody(req));
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    // A broadcast reaches everyone at once, so a player placeholder in it would scroll past as raw
    // braces. Checked on the rotation as it will RUN — switching it off is never refused.
    const storedBroadcast = await ctx.repo.broadcast.getConfig(params.id!);
    const before = priorOf(storedBroadcast, parsed.value, BROADCAST_DEFAULTS);
    const nextBroadcast = { ...BROADCAST_DEFAULTS, ...storedBroadcast, ...parsed.value };
    if (nextBroadcast.enabled) {
      for (const m of nextBroadcast.messages) {
        const bad = serverWideTextError(m, "a broadcast");
        if (bad) return sendError(res, 400, bad);
      }
    }
    const config = await ctx.repo.broadcast.upsertConfig(params.id!, parsed.value);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "broadcast.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated broadcast rotation for ${server.name}${config.enabled ? "" : " (disabled)"}${config.dryRun ? " (dry-run)" : ""} — ${config.messages.length} message(s)`,
      data: { patch: parsed.value, before },
    });
    sendJson(res, 200, { config });
  }),

  // --- Game rewards (Auto settings → Game rewards): top stats, kill streaks, consecutive days ---
  // Configured under the auto-settings permission; a config that PAYS something additionally needs
  // the permission to pay it — VIP-grant rights for VIP hours, bulk-payout rights for points — or a
  // staffer who may only edit automation could hand out VIP through it.
  serverRoute("GET", "/api/servers/:id/game-rewards", "autosettings.profiles", "read", async ({ res, ctx, params }) => {
    const stored = await ctx.repo.gameRewards.getConfig(params.id!);
    // Enough to hold a full server's match end AND the top-stats winners paid just before it —
    // 25 was one match's worth of "everyone at match end" lines, and pushed the winners out.
    const recent = await ctx.repo.audit.list({ actions: ["game.reward"], serverId: params.id!, limit: 200 }).catch(() => []);
    sendJson(res, 200, {
      config: stored?.config ?? mergeGameRewards(GAME_REWARDS_DEFAULTS), configured: stored !== null,
      recent: recent.map((r) => ({ at: r.ts, summary: r.summary, player: r.targetName ?? r.targetId, kind: String((r.data as { kind?: unknown } | null)?.kind ?? "") })),
    });
  }),

  serverRoute("PUT", "/api/servers/:id/game-rewards", "autosettings.profiles", "write", async ({ req, res, ctx, params, p, server }) => {
    const current = (await ctx.repo.gameRewards.getConfig(params.id!))?.config ?? mergeGameRewards(GAME_REWARDS_DEFAULTS);
    const parsed = parseGameRewardsBody(await readJsonBody(req), current);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    // Only a change to what is PAID needs the paying permission — editing a message, or anything
    // still in dry-run, does not; switching a VIP reward live, or raising one, does.
    const before = livePayouts(current), after = livePayouts(parsed.value);
    if (after.vip && after.vip !== before.vip && !can(p.grants, "vip.grant", "write", { serverId: params.id! })) return sendForbidden(res, "vip.grant", "write");
    if (after.points && after.points !== before.points && !can(p.grants, "economy.payout", "write")) return sendForbidden(res, "economy.payout", "write");
    const was = priorOf(current, current);
    const saved = await ctx.repo.gameRewards.setConfig(params.id!, parsed.value);
    const on = (["topStats", "bestSquads", "killStreaks", "playDays", "seedDays"] as const).filter((k) => saved.config[k].enabled)
      .map((k) => `${k}${saved.config[k].dryRun ? " (dry-run)" : ""}`);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "gamerewards.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated game rewards for ${server.name} — ${on.length ? `on: ${on.join(", ")}` : "all off"}`,
      data: { config: saved.config, before: was },
    });
    sendJson(res, 200, { config: saved.config });
  }),

  // --- Live welcome message: a template the worker fills and writes to the game's welcome text on a
  // timer, only when the result changed (see WelcomeConfigRow). Same gate as the broadcast config.
  serverRoute("GET", "/api/servers/:id/welcome", "broadcast.config", "read", async ({ res, ctx, params }) => {
    const stored = await ctx.repo.welcome.getConfig(params.id!);
    const config = stored ?? { serverId: params.id!, ...WELCOME_DEFAULTS, lastText: null, lastWrittenAt: null, updatedAt: new Date(0).toISOString() };
    sendJson(res, 200, { config, configured: stored !== null });
  }),

  serverRoute("PUT", "/api/servers/:id/welcome", "broadcast.config", "write", async ({ req, res, ctx, params, p, server }) => {
    const body = await readJsonBody(req);
    const patch: WelcomeConfigPatch = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.template !== undefined) {
      const template = str(body.template);
      if (template.length > 1000) return sendError(res, 400, "welcome message too long (max 1000 chars)");
      patch.template = template;
    }
    if (body.intervalSec !== undefined) {
      const n = Math.floor(Number(body.intervalSec));
      if (!Number.isFinite(n) || n < WELCOME_INTERVAL_MIN_SEC || n > WELCOME_INTERVAL_MAX_SEC) {
        return sendError(res, 400, `intervalSec must be between ${WELCOME_INTERVAL_MIN_SEC} and ${WELCOME_INTERVAL_MAX_SEC}`);
      }
      patch.intervalSec = n;
    }
    const storedWelcome = await ctx.repo.welcome.getConfig(params.id!);
    const before = priorOf(storedWelcome, patch, WELCOME_DEFAULTS);
    const next = { ...WELCOME_DEFAULTS, ...storedWelcome, ...patch };
    if (next.enabled && !next.template.trim()) return sendError(res, 400, "write the welcome message before switching it on");
    // The game shows ONE welcome text to every player, so it has no one to fill a player
    // placeholder for.
    const welcomeBad = next.enabled ? serverWideTextError(next.template, "the welcome message") : null;
    if (welcomeBad) return sendError(res, 400, welcomeBad);
    const config = await ctx.repo.welcome.upsertConfig(params.id!, patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "welcome.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated the live welcome message for ${server.name}${config.enabled ? ` (on, at most every ${Math.round(config.intervalSec / 60)} min)` : " (off)"}`,
      data: { patch, before },
    });
    sendJson(res, 200, { config });
  }),

  // One-shot: broadcast a message to the whole server right now (not the rotation). Refused on
  // observe-mode servers by the client, like every other write.
  serverRoute("POST", "/api/servers/:id/broadcast/send", "action.message", "write", async ({ req, res, ctx, params, p, server }) => {
    const message = str((await readJsonBody(req)).message).trim();
    if (!message) return sendError(res, 400, "message is required");
    if (message.length > 1000) return sendError(res, 400, "message too long (max 1000 chars)");
    const broadcastBad = serverWideTextError(message, "a broadcast");
    if (broadcastBad) return sendError(res, 400, broadcastBad);
    // Refused before connecting, like every other write route: observe mode is our own state, and
    // dressing it as an upstream failure sent staff hunting a connection problem that wasn't there.
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      // A broadcast has no single recipient, so only SERVER placeholders fill here ({server_name},
      // {map_name}, {next_map}…); a player one was refused above.
      const rendered = await rendererFor(ctx.repo, server, client).render(message);
      await client.execute("broadcast", { message: rendered });
    } catch (err) {
      // Observe mode is OUR refusal, not the game failing: answered as a conflict with the
      // server's state, so the panel says "this server is read-only" instead of "upstream error".
      if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") return sendError(res, 409, (err as Error).message);
      throw errors.upstream(`could not broadcast: ${(err as Error).message}`, { serverId: params.id });
    } finally {
      await client.disconnect().catch(() => {});
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "broadcast.send",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `broadcast to ${server.name}: ${message.slice(0, 120)}`,
      data: { message },
    });
    sendJson(res, 200, { ok: true });
  }),

  /**
   * Message EVERY player on the server — the top-right message that stays until acknowledged,
   * which is the one staff mean when they say "tell everyone". Distinct from the broadcast above:
   * that is the line scrolling across the top left, gone in seconds, and easy to play straight
   * past.
   *
   * The game has no send-to-all form of it, so this is a fan-out over the live roster — see
   * `messageEveryone`. It reports what actually happened (found/sent/failed) rather than a bare
   * ok, because "it said it sent" while half the server saw nothing is the failure this screen
   * exists to make visible.
   */
  serverRoute("POST", "/api/servers/:id/message/send", "action.message", "write", async ({ req, res, ctx, params, p, server }) => {
    const message = str((await readJsonBody(req)).message).trim();
    if (!message) return sendError(res, 400, "message is required");
    if (message.length > 1000) return sendError(res, 400, "message too long (max 1000 chars)");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const client = gameClientFor(server);
    let result;
    try {
      await connectGameClient(client, server);
      // Each recipient gets their OWN copy, so player placeholders fill per player here
      // ({player_name}, {vip_until}…) — one renderer, so the server's VIP list is read once.
      const renderer = rendererFor(ctx.repo, server, client);
      result = await messageEveryone(client, hasPlaceholders(message) ? (pl) => renderer.render(message, pl) : message);
    } catch (err) {
      // Same distinction as the broadcast above: messageEveryone rethrows ObserveModeViolation
      // precisely so it doesn't drown among per-player best-effort failures — honour that here.
      if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") return sendError(res, 409, (err as Error).message);
      throw errors.upstream(`could not message players: ${(err as Error).message}`, { serverId: params.id });
    } finally {
      await client.disconnect().catch(() => {});
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "message.all",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `messaged ${result.sent} player(s) on ${server.name}: ${message.slice(0, 120)}`,
      data: { message, ...result },
    });
    sendJson(res, 200, { ok: true, ...result });
  }),

  // --- Auto settings: the server managing itself — schedule/population/team-count settings
  //     profiles the worker resolves and applies. (Player-rule scenarios live on enforcer rules.) ---
  // Config editing is gated by server.config (it writes server settings). GET also returns the
  // game's writable config fields so the panel can build value pickers with no per-game code.
  serverRoute("GET", "/api/servers/:id/autosettings", "autosettings.profiles", "read", async ({ res, ctx, params, server }) => {
    const stored = await ctx.repo.autosettings.getConfig(params.id!);
    const config = stored ?? { serverId: params.id!, ...AUTOSETTINGS_DEFAULTS, updatedAt: new Date(0).toISOString() };
    // What a profile may set, grouped for the editor's one "Then…" menu: the game's writable
    // config fields, and the app's own automation switches (the master-control half).
    const fields = [
      ...[...configFieldsFor(server.game).values()].filter((f) => f.write).map((f) => ({ field: f.field, label: f.label, kind: f.kind, group: "Server settings" })),
      ...APP_SETTINGS.map((s) => ({ field: s.key, label: s.label, kind: s.kind as "bool", group: "App automation" })),
      ...FEATURE_PRESETS.map((f) => ({ field: `preset:${f.feature}`, label: `${f.label} preset`, kind: "str" as const, group: "Apply presets" })),
    ];
    sendJson(res, 200, { config, fields, configured: stored !== null });
  }),

  /**
   * The same exact two-axis coverage picture the map vote has, for auto-settings profiles. Both
   * features resolve first-match-wins on the same schedule engine, so "which profile owns Tuesday
   * 03:00 at 30 players" deserves the same exact regions the vote's page gets — not an "active
   * now" badge that answers only for this minute.
   *
   * Team-count conditions (allies/axis/balance gap) are a third axis this picture cannot draw:
   * a profile carrying one is reported in the same "can't be placed on the weekly clock" list as
   * the calendar-gated ones, never drawn wrong and never silently dropped.
   */
  serverRoute("GET", "/api/servers/:id/autosettings/coverage", "autosettings.profiles", "read", async ({ res, ctx, params, server }) => {
    const stored = await ctx.repo.autosettings.getConfig(params.id!);
    const tz = stored?.timezone ?? "UTC";
    const profiles = stored?.profiles ?? [];
    // The sides in this server's game's words ("US under 20" on Vietnam), not the stored ids.
    const sides = getGame(server.game)?.descriptor.sides ?? [];
    const side = (id: "allies" | "axis") => sides.find((s) => s.id === id)?.label ?? id;
    const teamBits = (s: NonNullable<AutoSettingsProfile["spec"]>): string[] => {
      const bits: string[] = [];
      if (s.alliedBelow !== undefined) bits.push(`${side("allies")} under ${s.alliedBelow}`);
      if (s.alliedAbove !== undefined) bits.push(`${side("allies")} over ${s.alliedAbove}`);
      if (s.axisBelow !== undefined) bits.push(`${side("axis")} under ${s.axisBelow}`);
      if (s.axisAbove !== undefined) bits.push(`${side("axis")} over ${s.axisAbove}`);
      if (s.teamDiffBelow !== undefined) bits.push(`team gap under ${s.teamDiffBelow}`);
      if (s.teamDiffAbove !== undefined) bits.push(`team gap over ${s.teamDiffAbove}`);
      // Minutes into the match is a clock of its own, not the week's — same list, same reason.
      if (s.matchMinutesAtLeast !== undefined) bits.push(`${s.matchMinutesAtLeast}+ min into the match`);
      if (s.matchMinutesBelow !== undefined) bits.push(`first ${s.matchMinutesBelow} min of the match`);
      return bits;
    };
    const drawable: { name: string; spec?: ScheduleSpec }[] = [];
    const conditionOnly: { name: string; when: string }[] = [];
    for (const p of profiles) {
      const bits = p.spec ? teamBits(p.spec) : [];
      if (bits.length) conditionOnly.push({ name: p.name, when: bits.join(" · ") });
      else drawable.push({ name: p.name, spec: p.spec as ScheduleSpec | undefined });
    }
    const report = describeCoverage(drawable as Parameters<typeof describeCoverage>[0], tz);
    sendJson(res, 200, { timezone: tz, ...report, calendarOnly: [...report.calendarOnly, ...conditionOnly] });
  }),

  // The live answer to "which profile is winning right now, and why". Resolved the same way the
  // worker does it, but against the latest roster SNAPSHOT (no RCON round-trip) — close enough
  // for a preview, honest about its age via sampledAt. Null counts = conditions on them can't
  // match, which is exactly what the worker would conclude too.
  serverRoute("GET", "/api/servers/:id/autosettings/status", "autosettings.profiles", "read", async ({ res, ctx, params }) => {
    const config = await ctx.repo.autosettings.getConfig(params.id!);
    const snap = await ctx.repo.rosterSnapshots.latest(params.id!);
    const playerCount = snap?.playerCount ?? null;
    const alliedCount = snap?.composition?.bySide?.["allies"]?.players ?? null;
    const axisCount = snap?.composition?.bySide?.["axis"]?.players ?? null;
    // Minutes into the current match, from the match the log tracker has open — the same clock
    // the worker reads.
    const openMatch = await ctx.repo.matches.getOpen(params.id!).catch(() => null);
    const matchMinutes = matchMinutesSince(openMatch?.startedAt, Date.now());
    let active: string | null = null;
    if (config && config.profiles.length > 0) {
      type P = { name: string; spec?: ScheduleSpec };
      const profiles = config.profiles.map((p) => (p.spec && !p.spec.timezone ? { ...p, spec: { ...p.spec, timezone: config.timezone } } : p)) as unknown as P[];
      active = resolveProfile(profiles, new Date(), { playerCount, alliedCount, axisCount, matchMinutes })?.name ?? null;
    }
    sendJson(res, 200, {
      enabled: config?.enabled ?? false, dryRun: config?.dryRun ?? true,
      active, playerCount, alliedCount, axisCount, sampledAt: snap?.ts ?? null,
      matchMinutes: matchMinutes === null ? null : Math.floor(matchMinutes),
    });
  }),

  serverRoute("PUT", "/api/servers/:id/autosettings", "autosettings.profiles", "write", async ({ req, res, ctx, params, p, server }) => {
    const parsed = parseAutoSettings(await readJsonBody(req), configFieldsFor(server.game));
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const missing = parsed.value.profiles ? await presetKeyMissing(ctx, p.grants, params.id!, parsed.value.profiles) : null;
    if (missing) return sendForbidden(res, missing, "write");
    // What the save replaces, kept on its record so the trail can say exactly what changed.
    const before = priorOf(await ctx.repo.autosettings.getConfig(params.id!), parsed.value, AUTOSETTINGS_DEFAULTS);
    const config = await ctx.repo.autosettings.upsertConfig(params.id!, parsed.value);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "autosettings.config",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `updated auto settings for ${server.name}${config.enabled ? "" : " (disabled)"}${config.dryRun ? " (dry-run)" : ""} — ${config.profiles.length} profile(s)`,
      data: { patch: parsed.value, before },
    });
    sendJson(res, 200, { config });
  }),

  /**
   * The automation firing history — every action the app's own machinery took (or dry-ran),
   * across every family: the Rules engine (firings and breaker trips), seeding enforcement,
   * auto-settings profile applies/drift rewrites, and the map-vote/broadcast automations. One paged, filterable read over the audit trail, scoped to AUTOMATION actors by
   * action-prefix allowlist — this is not a second Activity page, and it can never leak a staff
   * member's own actions to someone without the audit capability.
   *
   * Gated on holding ANY automation config capability at read: whoever may see how the machinery
   * is configured may see what it did.
   */
  route("GET", "/api/automation/history", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const caps = ["admin.moderation", "autosettings.profiles", "seeding.config"];
    const may = caps.some((c) => canAnywhere(p.grants, c, "read"));
    if (!may) return sendForbidden(res, "admin.moderation", "read");
    const u = new URL(req.url ?? "/", "http://local").searchParams;
    /*
     * Each server's machinery to whoever holds one of those on THAT server: staff trusted with
     * seeding on one server read that server's automation, not another's. Somebody who may see
     * every server also sees the rows that belong to none (a community-wide schedule), as Staff
     * activity does; naming a server they may not see is refused, not answered empty.
     */
    const all = await ctx.repo.servers.list({ includeRetired: true });
    const seesOn = (serverId: string) => caps.some((c) => can(p.grants, c, "read", { serverId }));
    const visible = all.filter((s) => seesOn(s.id)).map((s) => s.id);
    const serverId = str(u.get("serverId")).trim() || undefined;
    if (serverId && !seesOn(serverId)) return sendForbidden(res, "admin.moderation", "read");
    const scope = serverId ? { serverId } : visible.length === all.length ? {} : { serverIds: visible, includeUnscoped: false };
    const SOURCES: Record<string, string[]> = {
      rules: ["enforcer.", "rule."],
      seeding: ["seed."],
      autosettings: ["autosettings."],
      mapvote: ["mapvote.", "map."],
      broadcast: ["broadcast."],
    };
    const requested = str(u.get("sources")).split(",").map((x) => x.trim()).filter(Boolean);
    const chosen = requested.length ? requested.filter((x) => Object.hasOwn(SOURCES, x)) : Object.keys(SOURCES);
    if (requested.length && !chosen.length) return sendError(res, 400, `unknown source — pick from ${Object.keys(SOURCES).join(", ")}`);
    const limit = Math.min(Math.max(Number(u.get("limit")) || 50, 1), 200);
    const offset = Math.max(Number(u.get("offset")) || 0, 0);
    const query = {
      actionPrefixes: chosen.flatMap((x) => SOURCES[x]!),
      // Belt beside the prefix allowlist's braces: automation rows are stamped automated at write
      // time, so even an action name that strays into a listed prefix cannot expose a human's row
      // (rule edits do exactly that — "rule.create" is a staff act beside the automated
      // "rule.breaker") — and the (automated, ts) index serves this read on a trail with years in it.
      actor: "auto" as const,
      q: str(u.get("q")).trim() || undefined,
      dataRuleId: str(u.get("ruleId")).trim() || undefined,
      ...scope,
      order: u.get("order") === "asc" ? "asc" as const : "desc" as const,
      limit, offset,
    };
    const [entries, total] = await Promise.all([ctx.repo.audit.list(query), ctx.repo.audit.count(query)]);
    // A seeding row names its rule; the ground rules' detail is for the rules permission's holders.
    sendJson(res, 200, { entries: seedingAuditFor(entries, canAnywhere(p.grants, "admin.moderation", "read")), total, sources: Object.keys(SOURCES) });
  }),

  // --- Auto settings templates: saved behaviour sets (profiles + timezone), community-wide.
  //     A template deliberately never carries enabled/dry-run — applying one must not silently arm
  //     enforcement on a server that had it off. Profiles reference templates by NAME (applyTemplate),
  //     so names are unique case-insensitively and saving under an existing name replaces it. ---
  route("GET", "/api/autosettings/templates", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "autosettings.templates", "read")) return sendForbidden(res, "autosettings.templates", "read");
    sendJson(res, 200, { templates: await ctx.repo.autosettings.templates.list() });
  }),

  // Save-as-template: snapshot ONE server's current behaviour under a name. The snapshot is taken
  // server-side from the stored config, so what gets saved is exactly what is running — not
  // whatever half-edited state a browser tab happens to hold.
  route("POST", "/api/autosettings/templates", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "autosettings.templates", "write")) return sendForbidden(res, "autosettings.templates", "write");
    const body = await readJsonBody(req);
    const name = str(body.name).trim();
    if (!name) return sendError(res, 400, "name is required");
    if (name.length > 80) return sendError(res, 400, "name too long (max 80 chars)");
    const serverId = str(body.serverId).trim();
    if (!serverId) return sendError(res, 400, "serverId is required");
    // Saving a template COPIES this server's live auto-settings — its profiles, thresholds and
    // message text — into a community-wide record. That is a read of that server's configuration,
    // so it takes rights on THAT server: `autosettings.templates` is scoped, and the anywhere
    // check above only proves the account holds it somewhere.
    if (!can(p.grants, "autosettings.templates", "write", { serverId })) return sendForbidden(res, "autosettings.templates", "write", { serverId });
    const server = await ctx.repo.servers.findById(serverId);
    if (!server) return sendError(res, 404, "server not found");
    const stored = await ctx.repo.autosettings.getConfig(serverId);
    // The player-rule scenarios live on enforcer rules (Rules has its own save/restore via rule
    // setups), so a template carries the profiles and timezone only.
    const config = {
      timezone: stored?.timezone ?? AUTOSETTINGS_DEFAULTS.timezone,
      profiles: stored?.profiles ?? [],
    };
    const template = await ctx.repo.autosettings.templates.save({ name, config, createdByName: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "autosettings.template",
      targetType: "server", targetId: serverId, targetName: server.name, serverId,
      summary: `saved auto settings template "${template.name}" from ${server.name} — ${config.profiles.length} profile(s)`,
      data: { template: template.name, profiles: config.profiles.length },
    });
    sendJson(res, 200, { template });
  }),

  route("DELETE", "/api/autosettings/templates/:templateId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "autosettings.templates", "write")) return sendForbidden(res, "autosettings.templates", "write");
    const all = await ctx.repo.autosettings.templates.list();
    const target = all.find((t) => t.id === params.templateId);
    if (!target) return sendError(res, 404, "template not found");
    await ctx.repo.autosettings.templates.remove(target.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "autosettings.template",
      targetType: "config", targetId: target.id, targetName: target.name,
      summary: `deleted auto settings template "${target.name}"`,
      data: { template: target.name },
    });
    sendJson(res, 200, { ok: true });
  }),

  // Apply a template to ONE server: replaces its profiles and timezone. Enabled and dry-run are
  // untouched (behaviour changes; the arming switches stay where the server's staff set them) —
  // same contract as the worker's applyTemplate profile action. Older templates may still carry a
  // module blob from before the scenarios moved onto enforcer rules; it is ignored, never applied.
  serverRoute("POST", "/api/servers/:id/autosettings/apply-template", "autosettings.profiles", "write", async ({ req, res, ctx, params, p, server }) => {
    const name = str((await readJsonBody(req)).name).trim();
    if (!name) return sendError(res, 400, "name is required");
    const template = await ctx.repo.autosettings.templates.get(name);
    if (!template) return sendError(res, 404, "template not found");
    // A template's profiles go on this server's schedule as a save's would, so they answer to the
    // same keys the save asks for.
    const missing = await presetKeyMissing(ctx, p.grants, params.id!, template.config.profiles);
    if (missing) return sendForbidden(res, missing, "write");
    const applied = { timezone: template.config.timezone, profiles: template.config.profiles };
    const before = priorOf(await ctx.repo.autosettings.getConfig(params.id!), applied, AUTOSETTINGS_DEFAULTS);
    const config = await ctx.repo.autosettings.upsertConfig(params.id!, applied);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "autosettings.template",
      targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
      summary: `applied auto settings template "${template.name}" to ${server.name} — ${template.config.profiles.length} profile(s)`,
      data: { template: template.name, profiles: template.config.profiles.length, before, after: applied },
    });
    sendJson(res, 200, { config });
  }),

  // --- Feature presets: named behaviour snapshots of broadcast/map-vote/seeding configs. ---
  // One combined listing for the editors' pickers: every feature the caller may READ, with its
  // preset names. Features the caller can't read are simply absent — same shape either way.
  route("GET", "/api/presets", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const presets: Record<string, { id: string; name: string; game: string | null; createdByName: string; updatedAt: string }[]> = {};
    for (const f of FEATURE_PRESETS) {
      if (!canAnywhere(p.grants, f.capability, "read")) continue;
      presets[f.feature] = (await ctx.repo.featurePresets.list(f.feature)).map((r) => ({ id: r.id, name: r.name, game: r.game, createdByName: r.createdByName, updatedAt: r.updatedAt }));
    }
    sendJson(res, 200, { presets });
  }),

  // Per-feature CRUD + per-server apply, generated from the catalog — a new presettable feature
  // is one catalog entry, zero new route code. Gated by that feature's own config capability.
  ...FEATURE_PRESETS.flatMap((f): Route[] => [
    route("POST", `/api/presets/${f.feature}`, async (req, res, ctx) => {
      const p = await requirePrincipal(req, res, ctx);
      if (!p) return;
      if (!canAnywhere(p.grants, f.capability, "write")) return sendForbidden(res, f.capability, "write");
      const body = await readJsonBody(req);
      const name = str(body.name).trim();
      if (!name) return sendError(res, 400, "name is required");
      if (name.length > 80) return sendError(res, 400, "name too long (max 80 chars)");
      const serverId = str(body.serverId).trim();
      const server = serverId ? await ctx.repo.servers.findById(serverId) : null;
      if (!server) return sendError(res, 404, "server not found");
      // The snapshot is a read of THAT server's settings, so it needs the feature there: held on one
      // server only, saving from another copied its settings into a preset, ready to be applied
      // (and read back) on the server they do hold.
      if (!can(p.grants, f.capability, "read", { serverId: server.id })) return sendForbidden(res, f.capability, "read");
      // Snapshot the STORED config — what is actually running, not a browser tab's edits — and
      // remember which game it speaks for (see presetGameMismatch).
      const config = await f.snapshot(ctx.repo, serverId);
      const preset = await ctx.repo.featurePresets.save({ feature: f.feature, name, config, game: server.game, createdByName: p.name });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "preset.save",
        targetType: "server", targetId: serverId, targetName: server.name, serverId,
        summary: `saved ${f.label} preset "${preset.name}" from ${server.name}`,
        data: { feature: f.feature, preset: preset.name },
      });
      // The listing shape, not the row: a preset's config body never travels to a browser — the
      // snapshot may hold fields its saver isn't cleared to read back (seeding's containment),
      // and nothing client-side consumes it. Presets are applied by name, server-side.
      sendJson(res, 200, { preset: { id: preset.id, name: preset.name, game: preset.game, createdByName: preset.createdByName, updatedAt: preset.updatedAt } });
    }),

    route("DELETE", `/api/presets/${f.feature}/:presetId`, async (req, res, ctx, params) => {
      const p = await requirePrincipal(req, res, ctx);
      if (!p) return;
      if (!canAnywhere(p.grants, f.capability, "write")) return sendForbidden(res, f.capability, "write");
      const all = await ctx.repo.featurePresets.list(f.feature);
      const target = all.find((r) => r.id === params.presetId);
      if (!target) return sendError(res, 404, "preset not found");
      await ctx.repo.featurePresets.remove(target.id);
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "preset.delete",
        targetType: "config", targetId: target.id, targetName: target.name,
        summary: `deleted ${f.label} preset "${target.name}"`,
        data: { feature: f.feature, preset: target.name },
      });
      sendJson(res, 200, { ok: true });
    }),

    // Apply to ONE server: behaviour replaced, the feature's enabled/dry-run switches untouched.
    serverRoute("POST", `/api/servers/:id/presets/${f.feature}/apply`, f.capability, "write", async ({ req, res, ctx, params, p, server }) => {
      const name = str((await readJsonBody(req)).name).trim();
      if (!name) return sendError(res, 400, "name is required");
      const preset = await ctx.repo.featurePresets.get(f.feature, name);
      if (!preset) return sendError(res, 404, "preset not found");
      // A game-scoped preset is one game's vocabulary (role numbers, map ids, weapon names) —
      // applying it across games would silently enforce a policy nobody wrote.
      const mismatch = presetGameMismatch(f, preset.game, server.game);
      if (mismatch) return sendError(res, 409, mismatch);
      // A rules setup carrying a VIP, points or tag rule lands those powers on THIS server — the
      // same keys saving that rule here by hand takes (see the rule routes), or the setup is the
      // side door.
      if (f.feature === "rules") {
        const missing = setupKeyMissing(p.grants, preset.config, params.id!);
        if (missing) return sendForbidden(res, missing, "write");
      }
      // A seeding setup carries the seed reward. One that would change this server's reward takes
      // the reward's own permission here, as changing it by hand does (the seeding PUT above).
      if (f.feature === "seeding" && !can(p.grants, "seeding.rewards", "write", { serverId: params.id! })) {
        const current = (await ctx.repo.seeding.getConfig(params.id!)) ?? SEEDING_DEFAULTS;
        const { rewardBridge: _bridge, ...carried } = preset.config as Record<string, unknown>;
        if (rewardChanges(current, carried)) return sendForbidden(res, "seeding.rewards", "write");
      }
      await f.apply(ctx.repo, params.id!, preset.config);
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "preset.apply",
        targetType: "server", targetId: params.id!, targetName: server.name, serverId: params.id!,
        summary: `applied ${f.label} preset "${preset.name}" to ${server.name}`,
        data: { feature: f.feature, preset: preset.name },
      });
      sendJson(res, 200, { ok: true });
    }),
  ]),
];
