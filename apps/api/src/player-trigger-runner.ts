/**
 * The runtime half of per-player triggers (see player-triggers.ts for the pure logic).
 *
 * Subscribes to the bus alongside the enforcer, keeps the ARMED triggers in memory (refreshed on
 * a timer and after any mutation, exactly like the enforcer keeps its rules) so the hot path is a
 * pure in-memory match rather than a query per kill on a busy server, and executes the action a
 * matched trigger asks for — reusing the enforcer's RCON executor, and honouring observe mode and
 * the paid-VIP floor. A one-shot disarms the instant it fires and stays as a spent receipt.
 */
import { bankIfHeld, type Repository, type ServerRow, type PlayerTriggerRow, type PlayerTriggerStep, type VipRow } from "@app/db";
import type { EventBus } from "@app/bus";
import { background, createLogger } from "@app/shared";
import { applyRuleVars, defaultExecutor, type EnforceEvent } from "./enforcer.js";
import { AFK_DEFAULT_MINUTES, PLAYER_TRIGGER_AFK_KIND, triggerMatches, triggerSubjectsOf, shouldDisarm, describeTrigger, describeStep, roleNamerFor } from "./player-triggers.js";
import { addWatchReason } from "./watch.js";
import { renderActionText } from "./render-text.js";

const log = createLogger("player-triggers");

export interface PlayerTriggerRunnerDeps {
  repo: Repository;
  bus: EventBus;
  /** Execute an RCON action on an ACTIVE server. Observe servers never reach here (dry run). */
  execute?: (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void>;
  refreshMs?: number;
}

export class PlayerTriggerRunner {
  private armed: PlayerTriggerRow[] = [];
  /** Player-record ids that have at least one armed trigger — the cheap gate before any work. */
  private armedPlayers = new Set<string>();
  /** Lower-cased stored names of armed triggers' players — the fallback gate for the game's
   *  name-only moderation lines (KICK/BAN/PUNISH carry no id on the wire). */
  private armedNames = new Set<string>();
  private readonly repo: Repository;
  private readonly bus: EventBus;
  private readonly execute: (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void>;
  private readonly refreshMs: number;
  private unsub?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  // Step-delay waits in flight, so stop() can cancel them — a stopped runner never acts late,
  // and every cancelled wait resolves false so its firing settles as "cancelled" instead of
  // hanging a promise into shutdown.
  private waiters = new Map<ReturnType<typeof setTimeout>, (lapsed: boolean) => void>();
  // One-shot triggers whose chain is mid-flight. A one-shot only disarms once its chain settles,
  // so without this a second event during a pending delay would start a second chain from a
  // trigger that was meant to act exactly once.
  private firing = new Set<string>();
  // Loop brake for the game's log-line events: a kicked/banned trigger's OWN actions (or another
  // trigger's) can print the very line it fires on, and a cycle built across several triggers is
  // invisible to the single-row check at creation. One firing per trigger per minute bounds any
  // such cycle to a nuisance instead of a runaway.
  private logLineFiredMs = new Map<string, number>();
  /**
   * The AFK clock, kept only for players with an armed "afk" trigger: `${serverId}|${playerRecordId}`
   * → when they last connected or got a kill there (the Rules tab's AFK reads the same events), and
   * which of their AFK triggers already fired in this quiet spell. A kill starts a new spell.
   */
  private afkClocks = new Map<string, { serverId: string; playerId: string; playerName: string; lastActiveMs: number; fired: Set<string> }>();
  private afkPlayers = new Set<string>();
  /** When the sweep last asked where an AFK player without a clock is online (see runAfkSweep). */
  private afkLookedMs = new Map<string, number>();

  constructor(deps: PlayerTriggerRunnerDeps) {
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.execute = deps.execute ?? defaultExecutor();
    this.refreshMs = deps.refreshMs ?? 10_000;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => background(log, "player-trigger refresh", async () => { await this.refresh(); await this.runAfkSweep(); }), this.refreshMs);
    this.timer.unref?.();
    this.unsub = this.bus.on("*", (e) => background(log, "player-trigger event", () => this.onEvent(e as EnforceEvent)));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const [t, resolve] of this.waiters) { clearTimeout(t); resolve(false); }
    this.waiters.clear();
    this.unsub?.();
  }

  /** Reload the armed set. Called on a timer and after any create/toggle/fire/delete, so a
   *  disarmed one-shot leaves the hot path within a tick rather than firing twice. */
  async refresh(): Promise<void> {
    this.armed = await this.repo.playerTriggers.listArmed();
    this.armedPlayers = new Set(this.armed.map((t) => t.playerId));
    this.armedNames = new Set(this.armed.map((t) => t.playerName?.toLowerCase()).filter((n): n is string => !!n));
    this.afkPlayers = new Set(this.armed.filter((t) => t.event === "afk").map((t) => t.playerId));
    for (const [key, clock] of this.afkClocks) if (!this.afkPlayers.has(clock.playerId)) this.afkClocks.delete(key);
    for (const id of this.afkLookedMs.keys()) if (!this.afkPlayers.has(id)) this.afkLookedMs.delete(id);
  }

  /** Keep an AFK player's clock from the events flowing past anyway: a connect or a kill starts a
   *  new quiet spell, and leaving the server ends the clock there. */
  private trackAfk(e: EnforceEvent): void {
    if (!e.serverId || !e.actorPlayerId || !this.afkPlayers.has(e.actorPlayerId)) return;
    const key = `${e.serverId}|${e.actorPlayerId}`;
    if (e.kind === "evt.player.disconnected") { this.afkClocks.delete(key); return; }
    if (e.kind === "evt.player.connected" || e.kind === "evt.kill" || e.kind === "evt.teamkill") {
      this.afkClocks.set(key, { serverId: e.serverId, playerId: e.actorPlayerId, playerName: e.actorName ?? "", lastActiveMs: Date.parse(e.ts ?? "") || Date.now(), fired: new Set() });
    }
  }

  /**
   * Walk the AFK clocks against the armed "afk" triggers, firing each one whose minutes have passed
   * without a kill — once per quiet spell, so "every time" means every spell. Public so tests can
   * drive it; the refresh timer calls it.
   *
   * A player armed while already on a server has no clock until their next connect or kill, and
   * one sitting idle would never get one. So a player without a clock is looked up (at most once a
   * minute) and given one from NOW on each server they are online: the minutes count from when
   * the trigger started watching, never from a guess about the past.
   *
   * Nor is a clock trusted to still mean somebody is there. It ends on the DISCONNECTED line, which
   * a server crash or restart never writes, so before anything fires the open sessions are asked
   * where the players with a trigger due are, in one read (the enforcer's dropDepartedClocks, for
   * the same reason): a clock they do not place on its server is dropped instead of fired, and when
   * presence cannot be read nothing fires that round.
   */
  async runAfkSweep(nowMs: number = Date.now()): Promise<void> {
    const afk = this.armed.filter((t) => t.event === "afk");
    if (!afk.length) return;
    const clocked = new Set([...this.afkClocks.values()].map((c) => c.playerId));
    for (const playerId of new Set(afk.map((t) => t.playerId))) {
      if (clocked.has(playerId) || nowMs - (this.afkLookedMs.get(playerId) ?? 0) < 60_000) continue;
      this.afkLookedMs.set(playerId, nowMs);
      const on = await this.repo.sessions.openServers(playerId).catch(() => null);
      for (const serverId of on ?? []) {
        const key = `${serverId}|${playerId}`;
        if (!this.afkClocks.has(key)) this.afkClocks.set(key, { serverId, playerId, playerName: "", lastActiveMs: nowMs, fired: new Set() });
      }
    }
    const minutesOf = (t: PlayerTriggerRow) => Math.max(1, Number(t.params?.minutes ?? AFK_DEFAULT_MINUTES));
    const due = [...this.afkClocks].filter(([, clock]) =>
      afk.some((t) => t.playerId === clock.playerId && !clock.fired.has(t.id) && nowMs - clock.lastActiveMs >= minutesOf(t) * 60_000));
    if (!due.length) return;
    const present = await this.repo.sessions.openServersFor([...new Set(due.map(([, clock]) => clock.playerId))]).catch(() => null);
    if (!present) return;
    for (const [key, clock] of due) {
      // Only the clock that was asked about: a kill or a reconnect while the read ran started a new one.
      if (this.afkClocks.get(key) === clock && !present.get(clock.playerId)?.includes(clock.serverId)) this.afkClocks.delete(key);
    }
    // Fired concurrently and awaited together, like the bus path: one trigger's delayed step must
    // not hold up another's.
    const firing: Promise<void>[] = [];
    for (const clock of this.afkClocks.values()) {
      for (const t of afk) {
        if (t.playerId !== clock.playerId || clock.fired.has(t.id)) continue;
        const minutes = minutesOf(t);
        if (nowMs - clock.lastActiveMs < minutes * 60_000) continue;
        clock.fired.add(t.id);
        firing.push(this.onEvent({
          kind: PLAYER_TRIGGER_AFK_KIND, serverId: clock.serverId, actorPlayerId: clock.playerId,
          actorName: clock.playerName || t.playerName || "", ts: new Date(nowMs).toISOString(),
          data: { triggerId: t.id, minutes },
        } as EnforceEvent));
      }
    }
    await Promise.all(firing);
  }

  async onEvent(e: EnforceEvent): Promise<void> {
    if (!e || typeof e.kind !== "string") return;
    this.trackAfk(e);
    // A bus event can name several subjects — the actor's kill is the victim's death — and the
    // game's own KICK/BAN lines name their subject only by NAME. The cheap gate checks both sets.
    const subjects = triggerSubjectsOf(e);
    if (!subjects.length) return;
    const interesting = subjects.some((s) =>
      (s.playerId && this.armedPlayers.has(s.playerId)) ||
      (!s.playerId && s.playerName && this.armedNames.has(s.playerName.toLowerCase())));
    if (!interesting) return;
    // Matching triggers fire CONCURRENTLY: one trigger's 60s delayed step must never hold up the
    // player's other triggers on the same event (a serial loop here would).
    const matches = this.armed.filter((t) => triggerMatches(t, e));
    await Promise.all(matches.map(async (t) => {
      try {
        await this.fire(t, e);
      } catch (err) {
        log.warn("player trigger fire failed", { trigger: t.id, err: (err as Error).message });
      }
    }));
  }

  private async fire(t: PlayerTriggerRow, e: EnforceEvent): Promise<void> {
    if (!e.serverId) return;
    if (t.event === "kicked" || t.event === "banned") {
      const last = this.logLineFiredMs.get(t.id) ?? 0;
      if (Date.now() - last < 60_000) return; // the loop brake — see the field note on the map above
      this.logLineFiredMs.set(t.id, Date.now());
    }
    if (t.fireOnce) {
      // Its chain is already in flight (a delayed step is still waiting): once means once. The
      // second event is simply not this trigger's to act on.
      if (this.firing.has(t.id)) return;
      this.firing.add(t.id);
    }
    try {
      await this.runChain(t, e);
    } finally {
      this.firing.delete(t.id);
    }
  }

  private async runChain(t: PlayerTriggerRow, e: EnforceEvent): Promise<void> {
    const server = await this.repo.servers.findById(e.serverId!);
    if (!server) return;
    const player = await this.repo.players.findById(t.playerId);
    if (!player) return; // the person this trigger names is gone; nothing to act on
    // A player record is one game's, and a server plays one game. So an event from a server of the
    // other game can only have matched by NAME (a vote, the game's own KICK and BAN lines): it is
    // someone else who goes by the same name, and nothing is done or recorded for it.
    if (player.game !== server.game) return;
    const playerId = player.platformId;
    const playerName = player.name || t.playerName || playerId;

    // Observe mode is the master safety, the same as the enforcer: the firing is RECORDED as a
    // dry run and never sent to the game — and it consumes nothing, so a one-shot built while a
    // server is still observe-only is waiting intact the day the server is armed. (The server's
    // "auto settings" switch does NOT gate a trigger: a trigger is a deliberate, per-player
    // instruction a person set up by hand, not part of the surface that switch turns off.)
    if (server.engagementMode !== "active") {
      await this.repo.audit.create({
        actorUserId: null, actorName: "player-trigger", action: "trigger.dryrun",
        targetType: "player", targetId: t.playerId, targetName: playerName, serverId: server.id,
        summary: `[dry-run] player trigger (${describeTrigger(t, roleNamerFor(server.game))}) would fire on ${playerName} — observe mode, nothing sent, the trigger stays armed`,
        data: { triggerId: t.id, event: t.event, steps: t.steps.map(describeStep), dryRun: true, createdBy: t.createdByName },
      }).catch(() => {});
      return;
    }

    /*
     * The steps run IN ORDER, each delay counted from the step before it — a LADDER: "message,
     * then 60s later kick, then 30s later …" lands the last step at the SUM of the delays, which
     * is exactly how staff read the builder's "then after N seconds". The firing settles —
     * counted, and a one-shot disarmed — only once every step has resolved, so the receipt
     * describes what actually happened, not what was scheduled. A pending delay lives in this
     * process's memory; stop() cancels it (a stopped runner never acts late, and the steps behind
     * a cancelled delay are cancelled with it), and a restart drops it — the honesty bound
     * MAX_CHAIN_DELAY_SEC on the chain's total exists precisely so that loss stays small.
     */
    const message = (st: PlayerTriggerStep) => applyRuleVars(st.message ?? "", e, playerName);
    const outcomes: { step: string; outcome: string; landed: boolean }[] = [];
    let halt: string | null = null; // set when the REST of the chain must not run
    for (const [idx, st] of t.steps.entries()) {
      if (halt) {
        outcomes.push({ step: describeStep(st), outcome: halt, landed: false });
        continue;
      }
      try {
        if (st.delaySec > 0) {
          const waited = await this.wait(st.delaySec * 1000);
          if (!waited) {
            halt = "cancelled — the runner stopped";
            outcomes.push({ step: describeStep(st), outcome: halt, landed: false });
            continue;
          }
          // Staff may have pulled the trigger while the delay ran — deleting or disabling it is
          // exactly how a pending ladder gets called off, so it stops the whole rest of the
          // chain. (On a transient read error we proceed: the instruction was armed when the
          // event happened.)
          const still = await this.repo.playerTriggers.get(t.id).catch(() => t);
          if (!still || !still.enabled || still.disarmedAt) {
            halt = "cancelled — the trigger was removed or disabled during the delay";
            outcomes.push({ step: describeStep(st), outcome: halt, landed: false });
            continue;
          }
          // Re-edited while this chain waited: the steps still queued here belong to a version
          // staff have since replaced, so the rest of this run stops rather than finishing it.
          if ((still.updatedAt ?? null) !== (t.updatedAt ?? null)) {
            halt = "cancelled — the trigger was edited during the delay";
            outcomes.push({ step: describeStep(st), outcome: halt, landed: false });
            continue;
          }
          // Observe mode was checked before the first step; a server put into it while this
          // ladder waited must stop the rest of it — the executor itself always connects active,
          // so this is the only place the master safety can still catch a delayed step.
          const serverNow = await this.repo.servers.findById(server.id).catch(() => server);
          if (!serverNow || serverNow.engagementMode !== "active") {
            halt = "cancelled — the server was put in observe mode (or removed) during the delay";
            outcomes.push({ step: describeStep(st), outcome: halt, landed: false });
            continue;
          }
          // The player may have left during the wait. Only the actions that land ON a present
          // player are held back by that — this skips ONE step; a ban or a grant further down
          // the ladder is true whether they stayed or not.
          if (st.action === "message" || st.action === "kick" || st.action === "punish" || st.action === "switch") {
            const on = await this.repo.sessions.openServers(t.playerId).catch(() => null);
            if (on !== null && !on.includes(server.id)) {
              outcomes.push({ step: describeStep(st), outcome: `skipped — ${playerName} left before the ${st.delaySec}s delay ran out`, landed: false });
              continue;
            }
          }
        }
        const detail = await this.perform(st, idx, server, player.id, playerId, playerName, message(st));
        outcomes.push({ step: describeStep(st), outcome: detail, landed: true });
      } catch (err) {
        outcomes.push({ step: describeStep(st), outcome: `FAILED: ${(err as Error).message}`, landed: false });
      }
    }

    const landed = outcomes.filter((o) => o.landed).length;
    const at = new Date().toISOString();
    // A one-shot is spent only by a firing that actually DID something: if every step was skipped
    // or failed (the player vanished, the server hiccuped), it stays armed for the next event —
    // the message left waiting for someone must not be used up by a miss.
    const disarm = shouldDisarm(t) && landed > 0;
    await this.repo.playerTriggers.recordFire(t.id, disarm, at).catch(() => {});
    if (disarm) {
      this.armed = this.armed.filter((x) => x.id !== t.id);
      if (!this.armed.some((x) => x.playerId === t.playerId)) this.armedPlayers.delete(t.playerId);
    }

    await this.repo.audit.create({
      actorUserId: null,
      actorName: "player-trigger",
      action: landed === t.steps.length ? "trigger.fire" : landed > 0 ? "trigger.partial" : "trigger.error",
      targetType: "player",
      targetId: t.playerId,
      targetName: playerName,
      serverId: server.id,
      summary: `player trigger (${describeTrigger(t, roleNamerFor(server.game))}) → ${playerName}: ${outcomes.map((o) => `${o.step} — ${o.outcome}`).join("; ")}`,
      data: { triggerId: t.id, event: t.event, fireOnce: t.fireOnce, disarmed: disarm, landed, of: t.steps.length, outcomes, playerId, createdBy: t.createdByName },
    }).catch(() => {});
  }

  /** A cancellable sleep: resolves true when the delay lapsed, false when stop() cut it short.
   *  Deliberately NOT unref'd: a step someone armed is work the process owes — a shutdown goes
   *  through stop(), which cancels these explicitly and settles each firing as cancelled, rather
   *  than the event loop quietly draining away a kick that was 40 seconds from landing. */
  private wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(timer); resolve(true); }, ms);
      this.waiters.set(timer, resolve);
    });
  }

  /** Do one step; return a short human detail for the receipt. Throws on failure. */
  private async perform(st: PlayerTriggerStep, idx: number, server: ServerRow, playerRecordId: string, playerId: string, playerName: string, message: string): Promise<string> {
    if (st.action === "points" || st.action === "takepoints") {
      const link = (await this.repo.externalLinks.list(playerRecordId).catch(() => [])).find((l) => l.provider === "discord")?.externalId;
      if (!link) throw new Error("no linked Discord account — points have no balance to land on");
      const ecoCfg = await this.repo.economy.config().catch(() => null);
      if (st.action === "takepoints") {
        // A deduction clamps at zero rather than throwing: "take 50" from a balance of 30 takes
        // the 30 — the receipt says what was actually taken.
        const member = await this.repo.economy.member(link);
        const take = Math.min(st.points, member?.balance ?? 0);
        if (take <= 0) return "balance already 0 — nothing to take";
        const out = await this.repo.economy.apply(
          { discordId: link, delta: -take, reason: `Player trigger on ${server.name}`, ref: `trigger:${playerId}:${idx}:${Date.now()}`, actorName: "player-trigger" },
        );
        return `took ${take} points (balance ${out.member.balance})`;
      }
      // The step index is part of the ref: two points steps in one chain land in the same
      // millisecond, and without it the second would be swallowed as a replay of the first.
      const out = await this.repo.economy.apply(
        { discordId: link, delta: st.points, reason: `Player trigger on ${server.name}`, ref: `trigger:${playerId}:${idx}:${Date.now()}`, actorName: "player-trigger" },
        { maxBalance: ecoCfg?.balanceCap ?? null },
      );
      return `granted ${out.entry.delta} points (balance ${out.member.balance})`;
    }
    if (st.action === "watch") {
      // The same shared helper the watchlist page uses: reason + flag, duplicate-safe, so an
      // every-time trigger does not stack identical reasons on each firing.
      const { reason } = await addWatchReason(this.repo, playerRecordId, {
        reason: message, by: { userId: null, name: "player-trigger" }, skipIfDuplicate: true,
      });
      return reason ? `added to the watchlist: "${message}"` : `already watched for "${message}" — not doubled`;
    }
    if (st.action === "vipremove") {
      const existing = await this.repo.vips.get(server.id, playerId);
      if (!existing) return "no VIP on this server — nothing to remove";
      if (existing.groupHold) return "they hold permanent VIP from a group perk — left alone until they leave the group";
      if (existing.expiration === null) {
        // A PERMANENT grant is a decision a person made, and no automation takes it away. The step
        // counts as done (so a one-shot does not retry forever), and the receipt says exactly what
        // to do instead.
        return "their VIP is PERMANENT — left untouched; remove it by hand from the VIPs page if you really mean to";
      }
      await this.execute(server, "vipremove", { playerId });
      // Only a TIMED grant goes. The read above saw a dated one, but telling the game takes a round
      // trip, and a grant made permanent (or taken into a group perk's hold) meanwhile is a decision
      // a person made: its row stays, and it gets back the game entry just taken from under it.
      if (!(await this.repo.vips.removeTimed(server.id, playerId))) {
        const now = await this.repo.vips.get(server.id, playerId);
        if (now && (now.groupHold || now.expiration === null)) {
          const offTheGame = Boolean(now.pausedUntil && Date.parse(now.pausedUntil) > Date.now());
          if (!offTheGame) await this.execute(server, "vip", { playerId, description: now.playerName || playerName }).catch(() => {});
          return "their VIP became permanent while this ran — left untouched, and put back on the game";
        }
        return "no VIP here any more — it was removed while this ran";
      }
      // The same audit row the by-hand revoke writes, so the player's VIP history tells the truth.
      await this.repo.audit.create({
        actorUserId: null, actorName: "player-trigger", action: "vip.revoke",
        targetType: "player", targetId: playerId, targetName: playerName, serverId: server.id,
        summary: `player trigger revoked VIP from ${playerName} on ${server.name} (was until ${existing.expiration})`,
        data: { playerId, wasExpiration: existing.expiration },
      }).catch(() => {});
      return `VIP removed (was until ${existing.expiration})`;
    }
    if (st.action === "vip") {
      // Cumulative, and it can never SHORTEN or downgrade — the paid-VIP floor. A permanent
      // grant is left exactly as it is (the store refuses the downgrade regardless); a dated
      // grant extends onto the later of its current expiry and now.
      // Permanent VIP from a group perk: the hours join the VIP they get back on leaving the group.
      const banked = async (row: VipRow) => {
        await this.repo.audit.create({
          actorUserId: null, actorName: "player-trigger", action: "vip.grant",
          targetType: "player", targetId: playerId, targetName: playerName, serverId: server.id,
          summary: `player trigger granted ${st.hours}h of VIP to ${playerName} on ${server.name} — they hold permanent VIP from a group perk, so it waits for them when they leave it`,
          data: { playerId, groupHeld: true, bankedMs: row.groupHold!.bankedMs, comment: "player trigger" },
        }).catch(() => {});
        return `${st.hours}h added to the VIP they get back on leaving their group`;
      };
      // A trigger is a reward: a group perk that takes none holds the grant like their own permanent.
      const basis = await bankIfHeld(this.repo, server.id, playerId, { addMs: st.hours * 3_600_000 }, { reward: true });
      if (basis.banked) return banked(basis.banked);
      const existing = basis.existing;
      if (existing && existing.expiration === null) {
        return basis.refusedBy
          ? `permanent VIP from group ${basis.refusedBy.map((n) => `"${n}"`).join(", ")}, whose perk takes no rewards — VIP left as is`
          : "already permanent — VIP left as is";
      }
      const now = Date.now();
      const base = existing?.expiration && Date.parse(existing.expiration) > now ? Date.parse(existing.expiration) : now;
      const expiration = new Date(base + st.hours * 3_600_000).toISOString();
      const paused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > now);
      if (!paused) await this.execute(server, "vip", { playerId, description: playerName });
      const row = await this.repo.vips.upsert({ serverId: server.id, playerId, playerName: existing ? null : playerName, comment: existing ? null : "player trigger", expiration, createdByUserId: null, createdByName: "player-trigger" });
      // A hold that began after the read took the hours into its frozen balance; permanent VIP
      // granted meanwhile absorbed them (the store's floor kept it permanent).
      if (row.groupHold) return banked(row);
      if (row.expiration === null) return "already permanent — VIP left as is";
      // The same audit row the by-hand grant writes, so the player's VIP history tells the truth —
      // what landed, since the store keeps the later of the grant's date and this one.
      await this.repo.audit.create({
        actorUserId: null, actorName: "player-trigger", action: "vip.grant",
        targetType: "player", targetId: playerId, targetName: playerName, serverId: server.id,
        summary: `player trigger granted VIP to ${playerName} on ${server.name} (until ${row.expiration})`,
        data: { playerId, expiration: row.expiration, comment: "player trigger" },
      }).catch(() => {});
      return `VIP until ${row.expiration}`;
    }
    // The RCON actions — message / kick / punish / tempban / permaban / switch — through the
    // shared executor.
    const hours = st.action === "tempban" ? (st.hours > 0 ? st.hours : 2) : 0;
    // The shared placeholders ({vip_until}, {server_name}…) fill here, after the rule's own.
    await this.execute(server, st.action, await renderActionText(this.repo, server, { playerId, reason: message, message, hours, adminName: "player-trigger" }, { playerId, playerName }));
    return st.action === "message" ? `messaged: "${message}"` : st.action === "switch" ? "switched to the other team" : st.action;
  }
}
