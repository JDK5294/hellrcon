/**
 * Seeding automod + the seed reward (VIP time, community points, or both).
 *
 * A server is in one of three phases by live player count:
 *   idle    (< minPlayers)      — basically empty; the automod does nothing and any in-flight
 *                                 seed cycle is abandoned.
 *   seeding (minPlayers..target) — special rules apply: players on a "disallowed" role are warned,
 *                                 then punished, then kicked; everyone present accrues seed time.
 *   live    (>= seedTarget)     — normal rules; the moment the server crosses into live, every
 *                                 player who seeded for long enough is rewarded — VIP time,
 *                                 community points, or both, whichever the config asks for.
 *
 * `planSeedingTick` is a PURE function of (config, roster, accrued progress, escalation memory,
 * previous phase) → decisions. The worker runner does all the I/O (RCON reads/writes, DB, audit),
 * which keeps the decision logic unit-testable without a game server.
 *
 * ---------------------------------------------------------------------------------------------
 * Portions derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool:
 *   the cap fight's detection (rcon/automods/seeding_rules.py, v12.1.1). Copyright (c) 2020
 *   Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { composeSeedingAnnounce, seedActionSummary, vipSpan } from "@app/db";
import type { NewAudit, Repository, SeedActionReason, SeedingConfigRow } from "@app/db";
import { attackerTeam, inferMode, LAYOUT_MIN_SHARE, onEndLine, onOuterLine, paintAxis, sectorLineOf, sectorOf, SECTOR_GRID, SECTOR_WORLD_EXTENT } from "@app/maps";

export type Phase = "idle" | "seeding" | "live";

/** One live player as the planner needs them (the runner maps the raw roster onto this). */
export interface SeedRosterPlayer {
  playerId: string;
  name: string;
  level: number;
  role: number;
  /** our custom tags on this player (for immunity); empty if none / not resolved. */
  tags: string[];
  /** resolved faction, for the cap-fight rule (null = unknown team). */
  side?: "allies" | "axis" | null;
  /** the game's offense score — climbs only while standing in an attack zone. */
  offense?: number | null;
  /** live world position for the containment rule. Null/absent = not placed (deploy screen, or
   *  the protocol did not report one) — never a violation. */
  pos?: { x: number; y: number } | null;
}

/** Per-player escalation memory, carried across ticks by the runner (in-process). */
export interface EscalationEntry {
  warns: number;
  lastWarnMs: number;
  punishes: number;
  lastPunishMs: number;
}
export type EscalationState = Map<string, EscalationEntry>;

export interface SeedAction {
  playerId: string;
  name: string;
  kind: "warn" | "punish" | "kick";
  message: string;
  /** which rule it enforced and what the player did — what its line in History says. */
  reason: SeedActionReason;
}

/**
 * The trail row a seeding action files. Its line is written for anyone who can read the trail
 * (seedActionSummary keeps the ground rules to "seeding rule"); the reason rides in the data,
 * where the API rebuilds the whole line for holders of the rules permission they answer to.
 */
export function seedActionAudit(act: SeedAction, serverId: string, dryRun: boolean): NewAudit {
  return {
    actorUserId: null, actorName: "seeding", action: `seed.${act.kind}`,
    targetType: "player", targetId: act.playerId, targetName: act.name || undefined, serverId,
    summary: seedActionSummary({ kind: act.kind, name: act.name || act.playerId, dryRun, ...act.reason }),
    data: { message: act.message, ...act.reason, ...(dryRun ? { dryRun: true } : {}) },
  };
}
export interface SeedTickInput {
  config: SeedingConfigRow;
  roster: SeedRosterPlayer[];
  /** accrued seed seconds per player from the DB (this cycle). */
  progress: Map<string, number>;
  escalation: EscalationState;
  /**
   * Ladder memory for WEAPON offences, separate from the role ladder above on purpose: a role
   * violation is a STATE (re-checked every tick, so recovery resets the ladder), while a weapon
   * kill is an EVENT — a quiet tick is not a recovery, and resetting on one would make every
   * offence the first. Same distinction @app/rules draws between roster-state triggers and
   * kill-event judging.
   */
  weaponEscalation?: EscalationState;
  /** kills since the last tick, keyed by the game's platform ids (the runner translates). */
  weaponKills?: { playerId: string; name: string; weapon: string }[];
  /** weapon → class id, from the game module (null = unclassified). */
  weaponClassOf?: (weapon: string) => string | null;
  /**
   * Session facts for the cap-fight rule: the mode (WARFARE ONLY — in warfare the team scores are
   * caps held; offensive-mode scores mean something else, so the rule stands down there, the same
   * line CRCON draws) and the two team scores. Absent = rule silently off this tick.
   */
  session?: { gameMode: string | null; alliedScore: number | null; axisScore: number | null; mapId?: string | null } | null;
  /**
   * Last observed offense score per player, carried across ticks. CRCON's detection verbatim
   * (seeding_rules.py): the first observation only RECORDS; a later observation that is HIGHER,
   * while the player's team already holds max caps, is a player standing in the enemy cap.
   */
  capOffense?: Map<string, number>;
  /** cap-fight ladder — separate from the role ladder, which resets on role recovery. */
  capEscalation?: EscalationState;
  /**
   * The seeding areas: each team's own painted ground on the current map, PRE-RESOLVED by the
   * runner (it knows the map; the planner should not). A player is judged only on the OTHER
   * team's ground — `allies` is where an Axis player is outside, `axis` where an Allies player
   * is — so empty and "both teams" squares judge nobody, and a null side (nothing painted for it)
   * leaves the other team free. Null for the whole thing means nothing to say this tick (disabled,
   * or nothing drawn for this map). Sector membership is judged with `sectorOf` from @app/maps —
   * the exact function the panel's picker draws with, so a clicked cell IS an enforced cell.
   * `ends` is the axis the paint runs along (resolveContainZone reads it off the paint): the first
   * grid line at each end of it is never judged.
   */
  containZone?: { allies: Set<string> | null; axis: Set<string> | null; ends?: "x" | "y" | null } | null;
  /**
   * Self-calibrating round geometry, carried across ticks (see AxisCalState). Feeds the
   * positional cap-fight check and zero-setup auto-containment. Null = fresh.
   */
  axisCal?: AxisCalState | null;
  /** This layer's LEARNED layout (map_layouts), when the evidence is trusted — lets the positional
   *  rules act from a round's first minutes instead of after the live calibration warms up. */
  learnedLayout?: { axis: "x" | "y"; alliesDir: -1 | 1; rounds: number } | null;
  /** when each player was FIRST seen past the front line (epoch ms) — the positional cap-fight
   *  grace timer's memory. */
  capPosState?: Map<string, number>;
  /** epoch ms the current round OPENED (the matches table knows) — the pace clock's zero, and the
   *  start of the layout learner's ten-minute window. Absent or null = unknown, and both hold
   *  rather than guessing a clock. */
  roundStartMs?: number | null;
  /** when each player was FIRST seen inside a still-locked band (epoch ms) — pace grace memory. */
  paceState?: Map<string, number>;
  /** steamroll-pace ladder — its own, for the same reason the cap fight owns one. */
  paceEscalation?: EscalationState;
  /** when each player was FIRST seen outside their zone (epoch ms) — the grace timer's memory. */
  containState?: Map<string, number>;
  /** containment ladder — its own, like the cap fight's: stepping back inside resets it, and a
   *  role recovery must not. */
  containEscalation?: EscalationState;
  /** the last COMMITTED phase (what the automod has been acting on). */
  prevPhase: Phase;
  /** a phase change awaiting confirmation, and when it was first observed (for phaseConfirmSec). */
  pendingPhase: Phase | null;
  pendingSinceMs: number;
  /** players who JOINED since the last tick (their connect events, by game id) — the seeding
   *  rules are told to each of them, once, if the server is seeding. */
  joined?: { playerId: string; name: string }[];
  elapsedSec: number;
  nowMs: number;
  /** epoch ms of the last reward round (0 = never), for the reward-delay debounce. */
  lastRewardMs: number;
  /** descriptor role number → label (for {violation} text). */
  roleName: (role: number) => string;
  /** weapon-class id → label, for the announcement's restriction list ("artillery" → "Artillery").
   *  Optional: with no game table the id is readable enough to print as-is. */
  weaponClassName?: (id: string) => string;
}
export interface SeedTickResult {
  phase: Phase;
  /** How the cap-fight rule read the round this tick (absent when it did not look) — the runner
   *  logs a change, so a rule standing down is never silent again. */
  capFightMode?: "warfare" | "other" | "unknown";
  /**
   * The cap-fight rule's condition this tick, classified (absent when it did not look). After
   * ticket closed-4996 — punish-first ON, a 4th point capped, not a word from the bot — the rule
   * may never hold its tongue about why it is not enforcing. "armed-blind" is the worst state:
   * a team IS at the cap line but none of its players carry an offense score, so the detector
   * cannot see the attack at all.
   */
  capFightState?: "armed" | "armed-blind" | "no-leader" | "holding-scores" | "holding-mode" | "standing-down";
  /** The state in plain words, with the numbers (scores, watched players) — what the runner logs. */
  capFightNote?: string;
  /** Round-geometry status in plain words ("calibrating…", "calibrated: x axis…"), whenever a
   *  session was read this tick. The runner logs a change. */
  geometryNote?: string;
  /** This round's reading of its layer, for the runner to record (once per round): set once
   *  TRAVEL_MIN_PLAYERS players' trips out of their own end agree (see foldTravel), with how many
   *  did. Absent or null until then, and for good if the opening ten minutes pass without it. */
  layoutSample?: { mapId: string; axis: "x" | "y"; alliesDir: -1 | 1; travelers: number } | null;
  axisCal: AxisCalState | null;
  capPosState: Map<string, number>;
  /** The pace rule's condition this tick, in plain words (absent when it did not look) — same
   *  self-reporting contract the cap fight learned from ticket closed-4996. */
  paceNote?: string;
  /** true when the pace rule is actively checking positions this tick (armed, not holding or
   *  standing down) — the runner then checks at the fast speed, in a live round too. */
  paceArmed?: boolean;
  paceState: Map<string, number>;
  paceEscalation: EscalationState;
  liveCount: number;
  seederCount: number;
  /** presence to accrue this tick (only while seeding). */
  progressAdds: { playerId: string; name: string; deltaSec: number }[];
  /** enforcement to apply (empty on dry-run? no — dry-run still returns them; the runner audits
   *  without sending). */
  actions: SeedAction[];
  /** the seeding rules, told to each player who joined while the server is seeding. */
  announces: { playerId: string; name: string; message: string }[];
  /** players to reward with VIP (on the seeding→live transition). */
  rewards: { playerId: string; name: string }[];
  /** true when a reward round actually fired this tick (cooldown was open) — the runner stamps
   *  lastRewardAt so the debounce holds through subsequent flaps across the go-live line. */
  rewarded: boolean;
  /** true when this go-live came within the repeat window of the last round (see
   *  config.rewardDelaySec): the runner pays only seeders NOT paid in that window, and thanks the
   *  rest. Never set by this function any more — kept on the type for archived cycles. */
  rewardDebounced?: boolean;
  /** end the cycle (clear accrued progress) — on →live (after rewards) or →idle. */
  clearProgress: boolean;
  escalation: EscalationState;
  weaponEscalation: EscalationState;
  capEscalation: EscalationState;
  capOffense: Map<string, number>;
  containState: Map<string, number>;
  containEscalation: EscalationState;
  /** carried-forward phase-confirmation state (runner keeps these across ticks). */
  pendingPhase: Phase | null;
  pendingSinceMs: number;
}

/**
 * A raw roster row's live position, for the containment rule. Both protocol spellings are read
 * (native worldPosition, the crcon bridge's world_position); an exact 0,0 is the deploy screen,
 * not the map centre, so it reports as "not placed" — the same judgement the restricted live
 * screen makes.
 */
/** A raw roster row's platform id, whatever the wire spelled the key ("iD", "id", "Id", "ID") —
 *  first NON-EMPTY wins, the same rule the live-payload readers learned when empty-id rows
 *  zeroed the PC platform counts. An id the seeding loop cannot read is a seeder who accrues
 *  nothing and a violator who cannot be warned, so the read must survive a casing change. */
export function rosterIdOf(pl: Record<string, unknown>): string {
  for (const k of ["iD", "id", "Id", "ID"]) {
    const v = pl?.[k];
    if (v != null) { const s = String(v).trim(); if (s) return s; }
  }
  return "";
}

export function rosterPosOf(pl: Record<string, unknown>): { x: number; y: number } | null {
  const wp = (pl?.worldPosition ?? pl?.world_position ?? null) as { x?: unknown; y?: unknown } | null;
  if (!wp) return null;
  const x = Number(wp.x), y = Number(wp.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x === 0 && y === 0) return null;
  return { x, y };
}

/** Replace {tokens} in a template. Unknown tokens are left as-is. */
export function applyVars(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/**
 * Raw phase for a count, WITH hysteresis: the boundary you cross to move UP is the plain threshold,
 * but to fall back DOWN the count must drop `phaseHysteresis` players below it. Which side of the
 * dead band applies depends on the phase we're currently committed to, so a count parked right on a
 * boundary doesn't oscillate.
 */
function rawPhaseFor(count: number, config: SeedingConfigRow, committed: Phase): Phase {
  const m = Math.max(0, config.phaseHysteresis);
  const liveThresh = committed === "live" ? config.seedTarget - m : config.seedTarget; // stay live in the dead band
  /*
   * …and never below 1: a server with NOBODY on it is idle, whatever the thresholds work out to.
   *
   * The dead band subtracts the hysteresis from minPlayers, and the two are configured
   * independently with nothing relating them — so a community that seeds from almost nothing
   * (minPlayers 2) with a wide band (hysteresis 5) lands on an idle threshold of -3, which a count
   * of zero is never below. The server then sits in `seeding` forever after everyone leaves, and
   * because the cycle only resets on the way into idle, the accrued seed progress, the escalation
   * ladders and the greeted-players set all survive: the next time the server fills, VIP is paid
   * out for minutes banked during an attempt that was abandoned hours ago.
   */
  const idleThresh = Math.max(1, committed === "idle" ? config.minPlayers : config.minPlayers - m); // stay out of idle in the dead band
  if (count >= liveThresh) return "live";
  if (count < idleThresh) return "idle";
  return "seeding";
}

function isImmune(p: SeedRosterPlayer, config: SeedingConfigRow): boolean {
  if (config.immuneLevel > 0 && p.level > 0 && p.level <= config.immuneLevel) return true;
  if (config.immuneTags.length && p.tags.some((t) => config.immuneTags.includes(t))) return true;
  return false;
}

/**
 * A genuine copy of a ladder state — entries included.
 *
 * `new Map(prev)` copies the keys and the REFERENCES, and the ladder below advances counters in
 * place (`st.warns += 1`), so the state the caller passed in was advanced too: this function is
 * documented as PURE and taking a previous state, and neither was true. @app/rules' escalation
 * runners had exactly this bug and fixed it with their own `copyState`; this is that fix applied
 * to the one place the pattern was left behind.
 *
 * It matters for the same reason it mattered there: a caller cannot undo what it cannot see. An
 * enforcement that fails to reach the game should leave the ladder where it was, and the only way
 * to put it back is to still hold the value it had.
 */
function copyEscalation(prev: EscalationState): EscalationState {
  const next: EscalationState = new Map();
  for (const [id, e] of prev) next.set(id, { ...e });
  return next;
}

/** Pure seeding decision for one tick. */
/**
 * The positional half of the cap fight — catching a winning-team player past the front line by
 * where they stand, beside the offense-score half — answers to its own switch (positionalEnabled,
 * on the ground rules under Auto settings → Map zones), off by default: off, the cap fight works
 * the way CRCON's does, by offense score alone. The seeding zones and steamroll protection answer
 * to their own switches (containEnabled, paceEnabled); one switch per job.
 */
export const capFightByPosition = (config: Pick<SeedingConfigRow, "positionalEnabled">): boolean => config.positionalEnabled === true;

export function planSeedingTick(input: SeedTickInput): SeedTickResult {
  const { config, roster, progress, prevPhase, elapsedSec, nowMs, roleName } = input;
  const escalation: EscalationState = copyEscalation(input.escalation);
  const weaponEscalation: EscalationState = copyEscalation(input.weaponEscalation ?? new Map());
  const capEscalation: EscalationState = copyEscalation(input.capEscalation ?? new Map());
  const containEscalation: EscalationState = copyEscalation(input.containEscalation ?? new Map());
  const paceEscalation: EscalationState = copyEscalation(input.paceEscalation ?? new Map());
  // Numbers are immutable, so a shallow copy IS a copy here.
  const capOffense = new Map(input.capOffense ?? []);
  const containState = new Map(input.containState ?? []);
  const capPosState = new Map(input.capPosState ?? []);
  const paceState = new Map(input.paceState ?? []);
  const count = roster.length;

  // Phase stability: the count suggests `raw` (with hysteresis), but a change only COMMITS after it
  // has held for phaseConfirmSec — so a brief spike/dip doesn't churn the phase (which would wipe
  // accrued seed progress and reset escalation). Until then we keep acting on the previously
  // committed phase.
  const raw = rawPhaseFor(count, config, prevPhase);
  let phase: Phase = prevPhase;
  let pendingPhase: Phase | null = input.pendingPhase;
  let pendingSinceMs = input.pendingSinceMs;
  if (raw === prevPhase) {
    pendingPhase = null; pendingSinceMs = 0; // nothing pending
  } else if (config.phaseConfirmSec <= 0) {
    phase = raw; pendingPhase = null; pendingSinceMs = 0; // confirm disabled → commit immediately
  } else if (pendingPhase === raw) {
    if (nowMs - pendingSinceMs >= config.phaseConfirmSec * 1000) { phase = raw; pendingPhase = null; pendingSinceMs = 0; }
  } else {
    pendingPhase = raw; pendingSinceMs = nowMs; // a new candidate → start its timer
  }

  const res: SeedTickResult = {
    phase, liveCount: count, seederCount: 0,
    progressAdds: [], actions: [], announces: [], rewards: [], rewarded: false,
    clearProgress: false, escalation, weaponEscalation, capEscalation, capOffense,
    containState, containEscalation,
    axisCal: input.axisCal ?? null, capPosState, paceState, paceEscalation,
    pendingPhase, pendingSinceMs,
  };

  /**
   * One ladder step, shared by the role loop and the weapon loop below — the third copy of this
   * logic in the file was the sign it wanted to be a function. Advances the entry IN PLACE (the
   * caller owns the copied map) and returns the action to apply, or null while an interval gate
   * holds it.
   */
  const stepLadder = (st: EscalationEntry, playerId: string, name: string, violation: string, why: Omit<SeedActionReason, "step">): SeedAction | null => {
    if (st.warns < config.maxWarnings) {
      if (nowMs - st.lastWarnMs < config.warnIntervalSec * 1000) return null;
      st.warns += 1; st.lastWarnMs = nowMs;
      return { playerId, name, kind: "warn", message: applyVars(config.warnMessage, {
        violation, player_name: name, received_warnings: st.warns, max_warnings: config.maxWarnings,
      }), reason: { ...why, step: { n: st.warns, of: config.maxWarnings } } };
    }
    if (st.punishes < config.maxPunishes) {
      if (nowMs - st.lastPunishMs < config.punishIntervalSec * 1000) return null;
      st.punishes += 1; st.lastPunishMs = nowMs;
      return { playerId, name, kind: "punish", message: applyVars(config.punishMessage, {
        violation, player_name: name, received_punishes: st.punishes, max_punishes: config.maxPunishes,
      }), reason: { ...why, step: { n: st.punishes, of: config.maxPunishes } } };
    }
    if (config.kickAfter) {
      return { playerId, name, kind: "kick", message: applyVars(config.kickMessage, { violation, player_name: name }), reason: { ...why } };
    }
    return null;
  };

  // ---- transitions ----
  if (phase === "idle") {
    // Server drained before it seeded — abandon the cycle. ONLY on a real seeding→idle step:
    // "idle with rows on record" is also exactly what a worker that just restarted MID-SEED sees
    // (its phase memory is RAM, and the phase-confirm window holds it at idle for its first
    // ticks), so clearing on that picture wiped every seeder's banked minutes on each update.
    if (prevPhase !== "idle") { res.clearProgress = true; escalation.clear(); weaponEscalation.clear(); capEscalation.clear(); capOffense.clear(); containState.clear(); containEscalation.clear(); capPosState.clear(); paceState.clear(); paceEscalation.clear(); res.axisCal = null; }
    return res;
  }

  /*
   * ANY arrival at live that is not "already live" runs the reward round — not just the
   * seeding→live step. The worker's phase memory is RAM, and the install updates by rebuilding
   * the containers: a worker that restarts while the server crosses the go-live line comes back
   * believing "idle", sees idle→live, and used to pay NOBODY — every seeder's banked minutes
   * stranded in the store. It cannot double-pay: every seeder paid leaves a seed.reward row, and
   * the runner leaves out anyone paid within the repeat window (splitRepeatSeeders) — including
   * a round a restart interrupted half way through. A server that was genuinely never seeding
   * simply has no progress rows and rewards nobody.
   */
  if (phase === "live" && prevPhase !== "live") {
    // Seed complete → everyone online who met the minimum qualifies, then the cycle resets.
    //
    // A re-crossing soon after a round (the population dropped and came back) used to be
    // suppressed WHOLE, so anyone who joined and seeded the second push got nothing. It now runs
    // like any round; the runner leaves out whoever was already paid within the repeat window
    // (config.rewardDelaySec) and thanks them instead — see splitRepeatSeeders.
    //
    // An arrival that did not come from seeding (a worker restart, most often while the server is
    // simply live) is a reward round only when there is banked seed time to pay — otherwise every
    // restart during prime time would stamp the round as if one had fired.
    const hasSeedToPay = prevPhase === "seeding" || progress.size > 0;
    if (config.rewardEnabled && hasSeedToPay) {
      res.rewarded = true;
      const need = config.minSeedMinutes * 60;
      for (const p of roster) {
        const accrued = (progress.get(p.playerId) ?? 0) + elapsedSec; // include the tick that crossed
        if (accrued >= need) res.rewards.push({ playerId: p.playerId, name: p.name });
      }
    }
    res.clearProgress = true;
    escalation.clear();
    weaponEscalation.clear();
    capEscalation.clear();
    capOffense.clear();
    containState.clear();
    containEscalation.clear();
    capPosState.clear();
    // The calibration and the pace rule's memory are ROUND-scoped, not cycle-scoped, and go-live
    // is the moment the steamroll clock matters most — they survive this transition and reset
    // with the round instead (the geometry fold below owns that reset).
    return res;
  }

  const onlineIds = new Set(roster.map((p) => p.playerId));

  // ---- round geometry: fold this tick's positions into the calibration (session ticks only) ----
  // Sits ABOVE the live-phase return on purpose: the calibration and the offensive pace rule are
  // ROUND rules, not seeding rules — they keep learning and enforcing after the server goes live,
  // which is exactly when a steamroll happens.
  let cal: AxisCalibration | null = null;
  // The round's geometry in ANY mode (live, else learned) — pace needs it on offensive rounds,
  // where the warfare-only `cal` is rightly null.
  let roundGeometry: AxisCalibration | null = null;
  let geomMode: "warfare" | "other" | "unknown" | null = null;
  if (input.session) {
    geomMode = warfareVerdict(input.session.gameMode, input.session.mapId);
    const key = String(input.session.mapId ?? "?");
    let st = res.axisCal;
    const a0 = input.session.alliedScore, x0 = input.session.axisScore;
    // A fresh warfare round on the SAME map (back-to-back repeat, sides possibly swapped) shows
    // as the scores returning to 2–2 from a decided line — that must reset the ends too.
    const freshRound = st !== null && a0 === 2 && x0 === 2
      && st.lastScores.allied != null && st.lastScores.axis != null
      && !(st.lastScores.allied === 2 && st.lastScores.axis === 2);
    if (st === null || st.roundKey !== key || freshRound) {
      st = blankAxisCal(key);
      // A new round is a new pace clock and a clean slate — a ladder spent last round must not
      // make this round's first offence land on punish.
      paceState.clear();
      paceEscalation.clear();
    }
    if (a0 != null && x0 != null) st.lastScores = { allied: a0, axis: x0 };
    for (const p of roster) {
      if (!p.pos || (p.side !== "allies" && p.side !== "axis")) continue;
      // Where a LABEL stands on an HQ line is no evidence of which end its team holds: at the
      // start of a round both teams show there (see onEndLine). Which way the map runs is what
      // this is working out, so every edge line is set aside.
      if (!onOuterLine(p.pos)) {
        const t = st[p.side];
        t.x += p.pos.x; t.y += p.pos.y; t.n += 1;
      }
      const fs = st.firstSeen.get(p.playerId) ?? { x: 0, y: 0, n: 0 };
      if (fs.n < ORIGIN_MAX_SAMPLES) {
        // The extremes are the ORIGIN — where the player entered the world — so only the first
        // ORIGIN_MIN_SAMPLES sightings feed them; a sprint deep afterwards is not where they started.
        if (fs.n < ORIGIN_MIN_SAMPLES) {
          fs.minX = Math.min(fs.minX ?? p.pos.x, p.pos.x); fs.maxX = Math.max(fs.maxX ?? p.pos.x, p.pos.x);
          fs.minY = Math.min(fs.minY ?? p.pos.y, p.pos.y); fs.maxY = Math.max(fs.maxY ?? p.pos.y, p.pos.y);
        }
        fs.x += p.pos.x; fs.y += p.pos.y; fs.n += 1;
        st.firstSeen.set(p.playerId, fs);
      }
    }
    res.axisCal = st;
    const liveCal = calibrationOf(st);
    const merged = mergeGeometry(liveCal, input.learnedLayout ?? null);
    roundGeometry = merged.cal;
    cal = geomMode === "warfare" ? merged.cal : null;
    const end = (c: { alliesDir: -1 | 1 }) => (c.alliesDir === -1 ? "low" : "high");
    res.geometryNote = merged.source === "conflict"
      ? `live spawns disagree with the learned layout for this map (${input.learnedLayout!.axis} axis, allies ${end(input.learnedLayout!)} end) — positional rules standing down this round`
      : geomMode === "unknown"
        ? "not calibrating: game mode unreadable"
        : merged.source === "learned"
          ? `using the learned layout: ${merged.cal!.axis} axis, allies at the ${end(merged.cal!)} end (${input.learnedLayout!.rounds} round(s) of evidence)`
          : liveCal
            ? `calibrated: ${liveCal.axis} axis, allies at the ${end(liveCal)} end (split ${Math.round(liveCal.separation / 1000)}k)`
            : `calibrating: ${Math.min(st.allies.n, st.axis.n)}/${CAL_MIN_TEAM_SAMPLES} team samples`;
    // This round's vote for the layer comes from players walking OUT of their own end in its
    // opening minutes — never from where labels stand on the HQ lines (see foldTravel).
    foldTravel(st, roster, input.roundStartMs ?? null, nowMs);
    if (input.session.mapId) {
      const vote = travelVote(st.travel);
      res.layoutSample = vote ? { mapId: String(input.session.mapId), ...vote } : null;
    }
  }

  /*
   * Enforce the offensive PACE — steamroll protection. An offensive round moves through five
   * points in a fixed order, and the map id itself names the attacker (carentan_offensive_ger,
   * wdevb_offensivenva_day — both games spell it), so with the round geometry calibrated the bot
   * knows which fifth of the world each attacker stands in, counted from the attackers' own end.
   * `paceUnlockMinutes[k]` is the earliest round-minute the attacking team may set foot in point
   * band k; 0 = always open. Defenders are NEVER touched — falling back is the game, not a crime.
   *
   * Every fail-safe the other positional rules earned applies verbatim: no calibration → hold,
   * no round clock → hold, a side label the player's own origin does not corroborate → skip,
   * and a short grace before the ladder, because sprinting past a line chasing a fight is normal.
   */
  if (config.paceEnabled && input.session) {
    const attacker = attackerSideOf(input.session.mapId);
    // Offensive is not warfare, so the warfare-gated `cal` above is rightly null here — the pace
    // rule reads the same accumulated geometry itself. Centroid separation is mode-agnostic.
    const paceCal = attacker !== null ? roundGeometry : null;
    const startMs = input.roundStartMs ?? null;
    if (attacker === null) {
      res.paceNote = "standing down: not an offensive round (or the map id names no attacker)";
      paceState.clear();
      paceEscalation.clear();
    } else if (startMs === null || startMs <= 0 || startMs > nowMs) {
      res.paceNote = `holding: offensive round (${attacker} attacking), but the round's start time is unknown — no pace clock`;
      paceState.clear();
    } else if (!paceCal) {
      res.paceNote = `holding: offensive round (${attacker} attacking), geometry not calibrated yet (`
        + `${Math.min(res.axisCal?.allies.n ?? 0, res.axisCal?.axis.n ?? 0)}/${CAL_MIN_TEAM_SAMPLES} team samples)`;
      paceState.clear();
    } else {
      const elapsedMin = (nowMs - startMs) / 60_000;
      for (const p of roster) {
        if (p.side !== attacker || p.pos == null) { paceState.delete(p.playerId); continue; }
        // Only a label the player's own observed origin corroborates — mis-colored icons are a
        // known reality, and "skip" is the only safe answer to a label the ground disputes.
        if (originTrusted(res.axisCal!, paceCal, p.playerId, p.side) !== true) { paceState.delete(p.playerId); continue; }
        // Band counted from the ATTACKERS' end: bandOf counts from the allies end, so an axis
        // attack reads the same schedule mirrored.
        const fromAttacker = attacker === "allies" ? bandOf(p.pos, paceCal) : CAP_BANDS - 1 - bandOf(p.pos, paceCal);
        const unlockAt = config.paceUnlockMinutes[fromAttacker] ?? 0;
        if (unlockAt <= 0 || elapsedMin >= unlockAt) { paceState.delete(p.playerId); continue; }
        const since = paceState.get(p.playerId);
        if (since === undefined) { paceState.set(p.playerId, nowMs); continue; }
        if (nowMs - since < PACE_GRACE_SEC * 1000) continue;
        if (isImmune(p, config)) continue;
        const st = paceEscalation.get(p.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
        const action = stepLadder(st, p.playerId, p.name,
          (config.paceNotice ?? "").trim()
            || `point ${fromAttacker + 1} does not unlock until minute ${unlockAt} — pushing ahead of the pace is not allowed`,
          { rule: "pace", detail: `reached point ${fromAttacker + 1} before it opens at minute ${unlockAt}` });
        paceEscalation.set(p.playerId, st);
        if (action) res.actions.push(action);
      }
      // Stable per round on purpose — the runner logs each change of this note, and a note that
      // carries the running minute would log once a minute for the whole round.
      res.paceNote = `armed: ${attacker} attacking, unlock schedule [${config.paceUnlockMinutes.join(", ")}] min`;
      res.paceArmed = true;
    }
  } else {
    paceState.clear();
    paceEscalation.clear();
  }
  for (const id of [...paceState.keys()]) if (!onlineIds.has(id)) paceState.delete(id);
  for (const id of [...paceEscalation.keys()]) if (!onlineIds.has(id)) paceEscalation.delete(id);

  if (phase === "live") {
    // Steady-state live: nothing to seed-enforce or accrue — only the round rules above run.
    return res;
  }

  // ---- phase === "seeding" ----
  // Accrue presence for everyone online.
  for (const p of roster) res.progressAdds.push({ playerId: p.playerId, name: p.name, deltaSec: elapsedSec });
  res.seederCount = roster.filter((p) => (progress.get(p.playerId) ?? 0) + elapsedSec >= config.minSeedMinutes * 60).length;

  // The rules, told once to each player who JOINS while the server is seeding, as CRCON tells them
  // (seeding_rules.on_connected). Greeting whoever was on the roster when a seeding cycle began
  // told everyone again after every phase change and every reconnect to the server: on through a
  // slow seed, a player heard it four or five times in one game. Composed from the config that
  // does the punishing, so the greeting always lists the rules actually in force (@app/db).
  const announceMessage = composeSeedingAnnounce(config, {
    role: roleName,
    weaponClass: input.weaponClassName ?? ((id) => id),
  });
  if (announceMessage) {
    const told = new Set<string>();
    for (const j of input.joined ?? []) {
      if (told.has(j.playerId)) continue;
      told.add(j.playerId);
      res.announces.push({ playerId: j.playerId, name: j.name, message: announceMessage });
    }
  }

  // Enforce disallowed roles.
  const disallowed = new Set(config.disallowedRoles);
  for (const p of roster) {
    const violating = disallowed.has(p.role) && !isImmune(p, config);
    if (!violating) { escalation.delete(p.playerId); continue; } // recovered → reset ladder

    const st = escalation.get(p.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
    const action = stepLadder(st, p.playerId, p.name, `${roleName(p.role)} is not allowed while seeding`, { rule: "role", detail: roleName(p.role) });
    escalation.set(p.playerId, st);
    if (action) res.actions.push(action);
  }
  // Drop escalation memory for players who left.
  for (const id of [...escalation.keys()]) if (!onlineIds.has(id)) escalation.delete(id);

  // Enforce disallowed weapons — the retired "Seeding rules" module, now on the same page, the
  // same phase machine and the same dry-run switch as the rest of seeding. Kills are events, so
  // an attacker no longer on the roster is skipped (a command naming an absent player does
  // nothing) and quiet ticks keep the ladder (see weaponEscalation).
  const byId = new Map(roster.map((p) => [p.playerId, p]));
  for (const kill of input.weaponKills ?? []) {
    const attacker = byId.get(kill.playerId);
    if (!attacker || isImmune(attacker, config)) continue;
    // Commander abilities are checked first and get their own violation wording: "BOMBING RUN is
    // not allowed" reads like a gun nobody recognises, while naming it a commander ability tells
    // the commander exactly which of their buttons crossed the line.
    const ability = isDisallowedCommanderAbility(config, kill.weapon);
    if (!ability) {
      const classId = input.weaponClassOf?.(kill.weapon) ?? null;
      if (!isDisallowedWeapon(config, classId, kill.weapon)) continue;
    }
    const st = weaponEscalation.get(kill.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
    const violation = ability
      ? `commander ability ${kill.weapon} is not allowed while seeding`
      : `${kill.weapon} is not allowed while seeding`;
    const action = stepLadder(st, kill.playerId, attacker.name || kill.name, violation, { rule: ability ? "ability" : "weapon", detail: kill.weapon });
    weaponEscalation.set(kill.playerId, st);
    if (action) res.actions.push(action);
  }
  for (const id of [...weaponEscalation.keys()]) if (!onlineIds.has(id)) weaponEscalation.delete(id);

  /*
   * Enforce the cap fight — CRCON's third seeding rule (seeding_rules.py, v12.1.1), the one the
   * original port missed, and the reason the winning team could push the 4th point unchallenged.
   *
   * Detection is CRCON's own, verbatim: WARFARE ONLY (there the team scores are caps held, 0–5;
   * offensive-mode scores mean something else, so the rule stands down rather than firing on
   * garbage). While a player's team already holds `capFightMaxCaps` points, their OFFENSE score
   * climbs only when they are standing in the enemy cap attacking it — so the first observation
   * merely RECORDS the score, and a later, higher one is the violation.
   *
   * The ladder is its own (capEscalation): the role ladder resets the moment a player's role
   * recovers, which for a cap-fighter on an ordinary role would wipe their steps every tick.
   * `capFightSkipWarning` is CRCON's skip_warning — the warning steps are marked spent so the
   * first offence lands on punish.
   */
  if (config.capFightEnabled && input.session) {
    const mode = geomMode ?? warfareVerdict(input.session.gameMode, input.session.mapId);
    res.capFightMode = mode;
    const scoresKnown = input.session.alliedScore != null || input.session.axisScore != null;
    if (mode === "unknown") {
      res.capFightState = "holding-mode";
      res.capFightNote = "holding: cannot read the game mode from the session, and the map id says nothing";
    } else if (!scoresKnown && mode === "warfare") {
      res.capFightState = "holding-scores";
      res.capFightNote = "holding: warfare round, but the session read carries no team scores";
    }
    if (mode === "unknown" || (!scoresKnown && mode === "warfare")) {
      /*
       * The session read came back empty — a blink, a reconnect, a build answering late.
       * "Couldn't read" is not "not warfare": clearing here wiped every attacker's baseline on
       * each blink, and the detector needs TWO sightings per player (record, then climb), so a
       * single hiccup bought a whole wave a free minute of capping. That staggered re-arming is
       * exactly the "punishes one person every 30 or so seconds" the field report described.
       * No evidence, no action — and no forgetting either.
       */
    } else if (mode !== "warfare") {
      capOffense.clear(); // scores mean something else here; a stale baseline must not fire next warfare round
      res.capFightState = "standing-down";
      res.capFightNote = "standing down: not a warfare round (team scores mean something else here)";
    } else {
      let winners = 0, watched = 0, noSide = 0, posWatched = 0;
      const acted = new Set<string>();
      for (const p of roster) {
        const teamScore = p.side === "allies" ? input.session.alliedScore
          : p.side === "axis" ? input.session.axisScore : null;
        // An unknown side or an unreadable side score is "cannot tell", never "not winning" —
        // the baseline HOLDS. Only a real score below the line proves the ground is legal again
        // (and then forgetting is right: the old baseline may contain climbs that were legal).
        if (teamScore == null) { if (p.side === null) noSide += 1; continue; }
        if (teamScore < config.capFightMaxCaps) { capOffense.delete(p.playerId); continue; }
        winners += 1;
        if (p.offense == null) continue; // their score column blinked this tick — keep what we know
        watched += 1;
        const prev = capOffense.get(p.playerId);
        capOffense.set(p.playerId, p.offense);
        if (prev === undefined || p.offense <= prev) continue; // first sight records; no climb, no attack
        if (isImmune(p, config)) continue;
        const st = capEscalation.get(p.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
        if (config.capFightSkipWarning) st.warns = Math.max(st.warns, config.maxWarnings);
        // The greeting's own words (capFightNotice) — the warn should quote the rule the player
        // was shown on join, not a second phrasing. Blank falls back to the stock sentence: an
        // enforcement message that names no rule reads as a bot malfunction.
        const action = stepLadder(st, p.playerId, p.name,
          (config.capFightNotice ?? "").trim() || "attacking the next point is not allowed while seeding",
          { rule: "capFight", detail: `their team already held ${teamScore} caps` });
        capEscalation.set(p.playerId, st);
        acted.add(p.playerId);
        if (action) res.actions.push(action);
      }
      /*
       * The POSITIONAL half: with the round geometry calibrated, a winning-team player standing
       * past the front line is caught by where they ARE, not by a score column deigning to move.
       * This is the detector the ecosystem doesn't have — CRCON's is score-only, and this week
       * showed what one silent score key costs. It shares the cap-fight ladder and wording (one
       * rule, two witnesses) and gives a short grace, because chasing a fight across the line for
       * a moment is normal and holding ground beyond it is the violation.
       */
      const flAgrees = cal !== null && res.axisCal !== null
        && frontLineAgrees(res.axisCal, cal, input.session.alliedScore, input.session.axisScore);
      if (capFightByPosition(config) && cal && res.axisCal && !flAgrees) {
        // The ground says the line is on the other side of the map from where the score puts it:
        // the side labels look flipped wholesale, and enforcing on them would punish the LOSING
        // team for attacking. Stand the positional half down and say so.
        res.geometryNote = "calibrated, but the front line sits mirrored from the score \u2014 side labels look flipped; positional cap fight standing down";
        capPosState.clear();
      }
      if (capFightByPosition(config) && cal && res.axisCal && flAgrees) {
        for (const p of roster) {
          if (p.side == null || p.pos == null || acted.has(p.playerId)) { capPosState.delete(p.playerId); continue; }
          // Only a label the player's own observed origin corroborates may be enforced on —
          // mis-colored icons on the live map are a known reality, and "skip" is the only safe
          // answer to a label the ground disputes (or has not yet witnessed).
          if (originTrusted(res.axisCal, cal, p.playerId, p.side) !== true) { capPosState.delete(p.playerId); continue; }
          const teamScore = p.side === "allies" ? input.session.alliedScore : input.session.axisScore;
          if (teamScore == null || teamScore < config.capFightMaxCaps) { capPosState.delete(p.playerId); continue; }
          if (!pastFrontLine(p.side, bandOf(p.pos, cal), input.session.alliedScore, input.session.axisScore)) {
            capPosState.delete(p.playerId); continue;
          }
          posWatched += 1;
          const since = capPosState.get(p.playerId);
          if (since === undefined) { capPosState.set(p.playerId, nowMs); continue; }
          if (nowMs - since < CAP_POS_GRACE_SEC * 1000) continue;
          if (isImmune(p, config)) continue;
          const st = capEscalation.get(p.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
          if (config.capFightSkipWarning) st.warns = Math.max(st.warns, config.maxWarnings);
          // The same line as the score half: that it was judged by position is a ground rule's detail.
          const action = stepLadder(st, p.playerId, p.name,
            (config.capFightNotice ?? "").trim() || "attacking the next point is not allowed while seeding",
            { rule: "capFight", detail: `their team already held ${teamScore} caps`, byPosition: true });
          capEscalation.set(p.playerId, st);
          if (action) res.actions.push(action);
        }
      } else {
        capPosState.clear();
      }
      const scoreLine = `scores ${input.session.alliedScore ?? "?"}\u2013${input.session.axisScore ?? "?"}`;
      const sideTail = noSide > 0 ? `; ${noSide} player(s) with no resolved side` : "";
      if (winners === 0) {
        res.capFightState = "no-leader";
        res.capFightNote = `armed: ${scoreLine}, no team at ${config.capFightMaxCaps} caps yet${sideTail}`;
      } else if (watched === 0 && !(capFightByPosition(config) && cal)) {
        // The condition ticket closed-4996 made us hunt for: the rule believes it is on, a team
        // is at the line, and it still cannot act — the roster rows carry no offense score, and
        // the round geometry has not calibrated yet either.
        res.capFightState = "armed-blind";
        res.capFightNote = `armed but BLIND: ${winners} winning-team player(s) and none carry an offense score \u2014 the roster read has no score data${sideTail}`;
      } else if (watched === 0) {
        res.capFightState = "armed";
        res.capFightNote = `armed: ${scoreLine}, watching by POSITION only (no offense scores readable; ${posWatched} past the line)${sideTail}`;
      } else {
        res.capFightState = "armed";
        res.capFightNote = `armed: ${scoreLine}, watching ${watched} of ${winners} winning-team player(s)`
          + (capFightByPosition(config) && cal ? `, ${posWatched} past the line by position` : "") + sideTail;
      }
    }
  } else {
    capOffense.clear();
    capPosState.clear();
  }
  for (const id of [...capEscalation.keys()]) if (!onlineIds.has(id)) capEscalation.delete(id);
  for (const id of [...capOffense.keys()]) if (!onlineIds.has(id)) capOffense.delete(id);
  for (const id of [...capPosState.keys()]) if (!onlineIds.has(id)) capPosState.delete(id);

  /*
   * Enforce the seeding areas — keep each team off the ground staff painted for the other. The
   * rule follows the geofence tools the HLL community already runs (FlorianSW/hll-geofences, MIT)
   * in spirit; the mechanics here are our own, judged from the same live positions the restricted
   * live screen reads.
   *
   * The judgements, in order, and each one deliberate:
   *  - the runner resolved this map's zones (containZone); nothing drawn = nothing enforced;
   *  - at/above containMaxPlayers the rule stands down entirely and forgets its timers — a seed
   *    that has grown that far is a real fight, and re-arming later must not inherit stale clocks;
   *  - a player with NO position (deploy screen, unreported) or no resolved side is never outside;
   *  - a player is judged only on the OTHER team's painted ground: empty squares and "both teams"
   *    squares are the same — free for everyone (the owner's rule: an empty middle is the middle
   *    painted for both, with less to go wrong) — and nothing painted for a side frees the other;
   *  - stepping outside starts a GRACE clock rather than a warn: crossing a sector line chasing a
   *    fight is normal, camping the far side of the map is the violation;
   *  - coming back inside clears the clock AND the ladder — like the role rules, this is a STATE,
   *    and recovery is recovery.
   */
  /*
   * Which fence applies — one switch (containEnabled) for both: a PAINTED zone when staff drew
   * one for this map (their judgement wins), else the AUTO fence once the round geometry is
   * known (the layer's learned layout, or this round read live) — each side keeps to its own two
   * home bands plus the shared middle band, the classic "fight over mid" seed rule, with no
   * per-map setup and immune to side swaps. Auto is warfare-only: its bands mean nothing in
   * other modes.
   */
  const autoFence = config.containEnabled && !input.containZone && cal && geomMode === "warfare" ? cal : null;
  const containArmed = (input.containZone || autoFence)
    && (config.containMaxPlayers <= 0 || count < config.containMaxPlayers);
  if (containArmed) {
    const zone = input.containZone;
    const MID = Math.floor(CAP_BANDS / 2);
    for (const p of roster) {
      let outside: boolean;
      if (zone) {
        const theirs = p.side === "allies" ? zone.axis : p.side === "axis" ? zone.allies : null;
        // The HQ line at each end of the paint's run is never judged (see onEndLine), even where
        // it is painted. A paint that names no direction takes the round's geometry's, else has none.
        const ends = zone.ends ?? roundGeometry?.axis ?? null;
        outside = theirs !== null && p.pos != null && !(ends !== null && onEndLine(p.pos, ends)) && theirs.has(sectorOf(p.pos.x, p.pos.y));
      } else {
        const side = p.side === "allies" || p.side === "axis" ? p.side : null;
        // The auto fence is label-flip-immune as a whole (it fences each cluster to the end that
        // cluster holds, whatever it is called) — but an INDIVIDUALLY mislabeled player would be
        // judged against the wrong half, so only labels the player's own origin corroborates
        // are enforced. Everyone else is skipped, never punished.
        const trusted = side !== null && res.axisCal ? originTrusted(res.axisCal, autoFence!, p.playerId, side) : null;
        // …and nobody is judged on the HQ line at either end (see onEndLine).
        const band = side !== null && p.pos != null && trusted === true && !onEndLine(p.pos, autoFence!.axis) ? bandOf(p.pos, autoFence!) : null;
        outside = band !== null && (side === "allies" ? band > MID : band < MID);
      }
      if (!outside) { containState.delete(p.playerId); containEscalation.delete(p.playerId); continue; }
      const since = containState.get(p.playerId);
      if (since === undefined) { containState.set(p.playerId, nowMs); continue; } // grace starts now
      if (nowMs - since < Math.max(0, config.containGraceSec) * 1000) continue;   // …and still runs
      if (isImmune(p, config)) continue;
      const st = containEscalation.get(p.playerId) ?? { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 };
      // The greeting's words again (containNotice) — warn with the rule the player was shown.
      const action = stepLadder(st, p.playerId, p.name,
        (config.containNotice ?? "").trim() || "going onto the other team's ground is not allowed while seeding",
        { rule: "zone", detail: zone ? "on the other team's painted ground" : "outside their team's half (auto zones)" });
      containEscalation.set(p.playerId, st);
      if (action) res.actions.push(action);
    }
  } else {
    containState.clear();
    containEscalation.clear();
  }
  for (const id of [...containState.keys()]) if (!onlineIds.has(id)) containState.delete(id);
  for (const id of [...containEscalation.keys()]) if (!onlineIds.has(id)) containEscalation.delete(id);

  return res;
}


// ---- self-calibrating round geometry (the no-map-painting answer) ----
//
// Every position rule before this needed staff to paint zones per map, twice over, because the
// attack axis differs per map and the teams swap ends between rounds. Fifty-plus maps of manual
// setup is a design flaw, not a chore. So the bot learns the geometry itself, live, each round:
// the two teams cluster at their own ends, and the axis with the widest separation between the
// team centers IS the cap axis, with each team's cluster naming its home end. Warfare's five cap
// bands are then fifths of the world square along that axis, and the front line comes from the
// team scores (in warfare, score = caps held). Nothing is configured, nothing is painted, and a
// side swap simply calibrates the other way around.

export const CAP_BANDS = 5;
/** accumulated player-position samples per team before the calibration may speak. */
export const CAL_MIN_TEAM_SAMPLES = 12;
/** minimum separation between the team centers along the chosen axis (world cm). Below this the
 *  teams are too mingled to tell the ends apart — mid-fight restarts stay honestly uncalibrated. */
export const CAL_MIN_SEPARATION = 30_000;
/** seconds a player may stand past the front line before the cap-fight ladder starts — walking
 *  near the line while fighting is normal; holding ground beyond it is the violation. */
export const CAP_POS_GRACE_SEC = 20;

/** seconds an attacker may stand inside a still-locked pace band before the ladder starts. */
export const PACE_GRACE_SEC = 20;

/**
 * Which side ATTACKS an offensive layer, read off the map id alone: both games bake the attacking
 * team into the id (carentan_offensive_ger, stmariedumont_off_us, wdevb_offensivenva_day), so no
 * per-map table is needed. GER and NVA sit in the axis slot; US, RUS, CW and British are all
 * allies. Null for anything that is not offensive — or an offensive id whose attacker the
 * patterns cannot name, because guessing an attacker means punishing the wrong team.
 */
export function attackerSideOf(mapId: string | null | undefined): "allies" | "axis" | null {
  const id = String(mapId ?? "").trim();
  if (!id) return null;
  const team = attackerTeam(id);
  if (team === null) return null;
  return team === "GER" || team === "NVA" ? "axis" : "allies";
}

/** Per-round accumulation of where each team stands. A new round key (map change, or scores
 *  returning to 2–2 from a decided line) resets it, so a side swap can never inherit the
 *  previous round's ends. */
export interface AxisCalState {
  roundKey: string;
  lastScores: { allied: number | null; axis: number | null };
  allies: { x: number; y: number; n: number };
  axis: { x: number; y: number; n: number };
  /** Each player's FIRST few positions this round — where they actually entered the world. The
   *  side label a player wears can be wrong (the restricted live map has shown mis-colored
   *  icons), and a label that disagrees with the player's own observed origin is not evidence
   *  anyone should be punished on. Capped at ORIGIN_MAX_SAMPLES per player. */
  firstSeen: Map<string, { x: number; y: number; n: number; minX?: number; maxX?: number; minY?: number; maxY?: number }>;
  /** The layout learner's trips out of each end this round (see foldTravel). */
  travel: TravelState;
}
export const blankAxisCal = (roundKey: string): AxisCalState => ({
  roundKey, lastScores: { allied: null, axis: null },
  allies: { x: 0, y: 0, n: 0 }, axis: { x: 0, y: 0, n: 0 },
  firstSeen: new Map(),
  travel: { startMs: null, trips: new Map(), done: new Map() },
});

// ---- layout learning by direction of travel ----

/** How long into a round its trips count: early on, everyone is walking out of their own end. */
export const TRAVEL_WINDOW_MS = 10 * 60_000;
/** Distinct players whose trips must agree before the round votes for its layer's layout. */
export const TRAVEL_MIN_PLAYERS = 5;
/** The grid line a trip out of an end must reach, the end's own (HQ) line being line 1. */
export const TRAVEL_TRIP_LINE = 3;

export interface TravelState {
  /** the round this tally belongs to — its start (epoch ms); a new match starts it afresh. */
  startMs: number | null;
  /** per player, how far along a trip out of each end they are — [west, east, north, south], each
   *  the grid line reached so far counting that end's own line as 1, 0 = not on a trip. */
  trips: Map<string, [number, number, number, number]>;
  /** players who finished a trip, and what it says: the axis, and which end the Allies hold. */
  done: Map<string, { axis: "x" | "y"; alliesDir: -1 | 1 }>;
}

/**
 * The layout learner. In a round's first TRAVEL_WINDOW_MS, a player seen on the first grid line at
 * one end, then the second, then the third — walking out of that end — has shown which end their
 * team holds. STANDING on the first line proves nothing: at the start of a round both teams show
 * there (players swapping sides, or still unassigned from the last match), so it only ever counts
 * as the start of a trip. A trip moves one grid line at a time; anything else (a redeploy across
 * the map, a jump) starts the count again. The side a finished trip counts for is the label the
 * player wears on reaching the third line, by when the start-of-round reads have settled.
 * Without a round clock nothing is learned — "the first ten minutes" of an unknown start could be
 * the middle of the round, where attackers walk out of the enemy's end too.
 */
export function foldTravel(st: AxisCalState, roster: SeedRosterPlayer[], roundStartMs: number | null, nowMs: number): void {
  if (roundStartMs === null || roundStartMs <= 0 || roundStartMs > nowMs) return;
  const t = st.travel;
  if (t.startMs !== roundStartMs) { t.startMs = roundStartMs; t.trips.clear(); t.done.clear(); }
  if (nowMs - roundStartMs >= TRAVEL_WINDOW_MS) return;
  for (const p of roster) {
    if (!p.pos || t.done.has(p.playerId)) continue;
    const col = sectorLineOf(p.pos.x), row = sectorLineOf(p.pos.y);
    // The line counted from each end, that end's own line being 1: west, east, north, south.
    const lines = [col + 1, SECTOR_GRID - col, row + 1, SECTOR_GRID - row];
    const at = t.trips.get(p.playerId) ?? [0, 0, 0, 0];
    for (let e = 0; e < 4; e++) {
      const line = lines[e]!, was = at[e]!;
      at[e] = line === 1 ? 1 : was > 0 && (line === was || line === was + 1) ? line : 0;
    }
    const finished = at.findIndex((line) => line >= TRAVEL_TRIP_LINE);
    if (finished >= 0 && (p.side === "allies" || p.side === "axis")) {
      // West and north are the negative ends of their axes.
      const end: -1 | 1 = finished % 2 === 0 ? -1 : 1;
      t.done.set(p.playerId, { axis: finished < 2 ? "x" : "y", alliesDir: p.side === "allies" ? end : end === -1 ? 1 : -1 });
      t.trips.delete(p.playerId);
      continue;
    }
    t.trips.set(p.playerId, at);
  }
}

/**
 * The round's vote, once its finished trips agree: TRAVEL_MIN_PLAYERS of them on one reading, and
 * that reading at least LAYOUT_MIN_SHARE of them all — a few labels that settled late are
 * outvoted, not followed. Null until then.
 */
export function travelVote(t: TravelState): { axis: "x" | "y"; alliesDir: -1 | 1; travelers: number } | null {
  const tally = new Map<string, { axis: "x" | "y"; alliesDir: -1 | 1; n: number }>();
  for (const r of t.done.values()) {
    const k = `${r.axis}${r.alliesDir}`;
    const cur = tally.get(k) ?? { ...r, n: 0 };
    cur.n += 1;
    tally.set(k, cur);
  }
  let best: { axis: "x" | "y"; alliesDir: -1 | 1; n: number } | null = null;
  for (const r of tally.values()) if (!best || r.n > best.n) best = r;
  if (!best || best.n < TRAVEL_MIN_PLAYERS || best.n / t.done.size < LAYOUT_MIN_SHARE) return null;
  return { axis: best.axis, alliesDir: best.alliesDir, travelers: best.n };
}

/** origin samples needed before a player's side label counts as corroborated (or contradicted). */
export const ORIGIN_MIN_SAMPLES = 2;
export const ORIGIN_MAX_SAMPLES = 5;

/** 0..1 along the calibrated axis, measured from the allies end. */
function normAlong(v: number, cal: AxisCalibration): number {
  const from = cal.alliesDir === -1 ? v + SECTOR_WORLD_EXTENT : SECTOR_WORLD_EXTENT - v;
  return Math.min(1, Math.max(0, from / (2 * SECTOR_WORLD_EXTENT)));
}

/**
 * Does this player's observed origin corroborate their side label? true = yes (their first
 * sightings sit on their labeled half), false = the origin CONTRADICTS the label, null = not
 * enough origin evidence yet. The positional rules only act on `true` — a mislabeled player is
 * skipped, never punished on a label the ground disputes.
 */
export function originTrusted(st: AxisCalState, cal: AxisCalibration, playerId: string, side: "allies" | "axis"): boolean | null {
  const fs = st.firstSeen.get(playerId);
  if (!fs || fs.n < ORIGIN_MIN_SAMPLES) return null;
  /*
   * Corroboration is "was this player, in their first sightings this round, standing on a side's
   * OWN ground" (the two home bands at that end) — the ends of what they were seen at, not the
   * average. The average split at the halfway line, so a seeder who first appeared on a mid
   * garrison — most of them — "corroborated" whichever label they wore by a few metres, and on a
   * tick the side guess came out backwards they were punished walking from mid to their own 2nd
   * point. The average also let a real violator sprinting deep drag their own origin to mid.
   * Now: seen on their labeled home ground and never on the other side's = trusted; seen on the
   * other side's home = contradicted; only ever seen in the middle = no evidence.
   */
  const avg = cal.axis === "x" ? fs.x / fs.n : fs.y / fs.n;
  const lo = cal.axis === "x" ? fs.minX ?? avg : fs.minY ?? avg;
  const hi = cal.axis === "x" ? fs.maxX ?? avg : fs.maxY ?? avg;
  const a = normAlong(lo, cal), b = normAlong(hi, cal);
  const nearest0 = Math.min(a, b), nearest1 = Math.max(a, b);
  const homeEdge = 2 / CAP_BANDS; // bands 0-1 from each end are a side's own ground
  const onAlliesHome = nearest0 < homeEdge, onAxisHome = nearest1 > 1 - homeEdge;
  const own = side === "allies" ? onAlliesHome : onAxisHome;
  const other = side === "allies" ? onAxisHome : onAlliesHome;
  if (other) return false;
  return own ? true : null;
}

/**
 * The raw team number → side map the positional rules may enforce on. Only a CONFIDENT read
 * (teamSidesConfident: the static mapping separates the teams, or the session headcounts match
 * exactly) may set it; an unconfident read — the norm while seeding, where even teams make the
 * headcounts useless and the resolver falls back to a guess that can come out backwards — defers
 * to what confident reads established, and a team never confidently placed has NO side here:
 * nobody is punished on a guess. `memory` persists across ticks for this server.
 */
/**
 * Forget the remembered team→side mapping when the round moves to a new map. The memory exists so
 * an unconfident read (even teams) defers to what confident reads established — but that promise
 * only holds within one match. On the builds where the guess is needed at all, a new match can
 * reseat which team number is which faction, and a mapping remembered from the last map would be
 * enforced as fact until the first confident read of this one.
 */
export function forgetSidesOnNewMap(memory: Map<number, string | null>, tracker: { mapId: string | null }, mapId: string | null): void {
  const id = String(mapId ?? "").trim().toLowerCase() || null;
  if (id && tracker.mapId && id !== tracker.mapId) memory.clear();
  if (id) tracker.mapId = id;
}

export function enforcementSides(
  resolved: Map<number, string | null>,
  confident: boolean,
  memory: Map<number, string | null>,
): Map<number, string | null> {
  if (confident) {
    for (const [t, sd] of resolved) memory.set(t, sd);
    return new Map(resolved);
  }
  return new Map([...resolved.keys()].map((t) => [t, memory.get(t) ?? null]));
}

/**
 * Does the observed front line sit where the score says it should? The two teams' centers face
 * each other across the fighting line; in warfare the line sits at alliedScore/5 from the allies
 * end. If the observed midpoint is strictly closer to the MIRRORED spot, the side labels look
 * flipped wholesale — and a flipped label set would make the positional cap fight punish the
 * losing team for attacking, so it must stand down instead. Even scores carry no signal (the two
 * spots coincide) and answer true.
 */
export function frontLineAgrees(st: AxisCalState, cal: AxisCalibration, alliedScore: number | null, axisScore: number | null): boolean {
  if (alliedScore == null || axisScore == null || alliedScore === axisScore) return true;
  if (st.allies.n === 0 || st.axis.n === 0) return true;
  const a = normAlong(cal.axis === "x" ? st.allies.x / st.allies.n : st.allies.y / st.allies.n, cal);
  const b = normAlong(cal.axis === "x" ? st.axis.x / st.axis.n : st.axis.y / st.axis.n, cal);
  const mid = (a + b) / 2;
  const expected = alliedScore / CAP_BANDS;
  return Math.abs(mid - expected) <= Math.abs(mid - (1 - expected));
}

export interface AxisCalibration {
  axis: "x" | "y";
  /** which end of the axis is the allies' home: -1 = the negative end, +1 = the positive end. */
  alliesDir: -1 | 1;
  /** distance between the team centers along the axis (world cm) — the confidence figure. */
  separation: number;
}

/** The calibration the accumulated evidence supports, or null while there is not enough of it. */
export function calibrationOf(st: AxisCalState | null | undefined): AxisCalibration | null {
  if (!st || st.allies.n < CAL_MIN_TEAM_SAMPLES || st.axis.n < CAL_MIN_TEAM_SAMPLES) return null;
  const a = { x: st.allies.x / st.allies.n, y: st.allies.y / st.allies.n };
  const b = { x: st.axis.x / st.axis.n, y: st.axis.y / st.axis.n };
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
  const separation = Math.max(dx, dy);
  if (separation < CAL_MIN_SEPARATION) return null;
  const axis = dx >= dy ? "x" as const : "y" as const;
  const alliesDir: -1 | 1 = (axis === "x" ? a.x < b.x : a.y < b.y) ? -1 : 1;
  return { axis, alliesDir, separation };
}

/**
 * The round's geometry from its two witnesses: the live calibration (this round's spawns) and the
 * layer's learned layout (earlier rounds' spawns). Live wins once it exists; learned covers the
 * warm-up. When both exist and DISAGREE, neither is used — enforcing on a layout the ground is
 * contradicting punishes the wrong team, and standing down is the only safe answer.
 */
export function mergeGeometry(
  live: AxisCalibration | null,
  learned: { axis: "x" | "y"; alliesDir: -1 | 1 } | null,
): { cal: AxisCalibration | null; source: "live" | "learned" | "conflict" | "none" } {
  if (live && learned && (live.axis !== learned.axis || live.alliesDir !== learned.alliesDir)) return { cal: null, source: "conflict" };
  if (live) return { cal: live, source: "live" };
  if (learned) return { cal: { axis: learned.axis, alliesDir: learned.alliesDir, separation: CAL_MIN_SEPARATION }, source: "learned" };
  return { cal: null, source: "none" };
}

/** Warfare cap band 0..4, counted from the ALLIES end of the calibrated axis. */
export function bandOf(pos: { x: number; y: number }, cal: AxisCalibration): number {
  const v = cal.axis === "x" ? pos.x : pos.y;
  const fromAlliesEnd = cal.alliesDir === -1 ? v + SECTOR_WORLD_EXTENT : SECTOR_WORLD_EXTENT - v;
  const width = (2 * SECTOR_WORLD_EXTENT) / CAP_BANDS;
  return Math.min(CAP_BANDS - 1, Math.max(0, Math.floor(fromAlliesEnd / width)));
}

/** Is this band past the side's front line, given the warfare scores (caps held)? */
export function pastFrontLine(side: "allies" | "axis", band: number, alliedScore: number | null, axisScore: number | null): boolean {
  if (side === "allies") return alliedScore != null && band >= alliedScore;
  return axisScore != null && band < CAP_BANDS - axisScore;
}

/**
 * Is this round Warfare — the only mode whose team scores are caps held, so the only one the cap
 * fight may judge? The field showed why exact string equality was wrong: live builds report
 * enum-shaped values (the same servers send platforms as `EPlatformFamily::Steam`), and any
 * spelling other than bare "warfare" disarmed the rule without a word while a seeder walked onto
 * the 4th point. So: the last `::` segment, letters only, matched loosely; and when the text is
 * empty or unfamiliar, the map id decides (ids carry the mode — `…_warfare`, `…_offensive…`,
 * `…Conquest…`). "unknown" only when neither says anything: couldn't tell is never "not warfare".
 */
export function warfareVerdict(gameMode: string | null | undefined, mapId: string | null | undefined): "warfare" | "other" | "unknown" {
  const token = (String(gameMode ?? "").split("::").pop() ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (token.includes("warfare")) return "warfare";
  if (/offensive|offense|offence|skirmish|conquest|domination/.test(token)) return "other";
  const id = String(mapId ?? "").trim();
  if (id) return inferMode(id) === "warfare" ? "warfare" : "other";
  return "unknown";
}

/**
 * Resolve one map's seeding areas into each team's own ground — the squares painted for that team
 * alone — which is where the OTHER team is judged. A square painted "both teams", or claimed by
 * both lists at once (only a hand-made request can), belongs to nobody's ground and judges nobody,
 * exactly like an empty one. Returns null when the config has nothing to say about this map (rule
 * off, no key, nothing painted at all); a SIDE comes back null when nothing is painted for it,
 * which leaves the other team free. A paint of "both teams" squares alone still comes back — it
 * judges nobody, but it is this map's paint, so it wins over a whole-family paint and over the
 * auto fence like any other. `ends` is the axis the paint runs along (paintAxis), whose first line
 * at each end — the HQ lines — is never judged.
 */
export function resolveContainZone(
  config: Pick<SeedingConfigRow, "containEnabled" | "containZones">,
  zoneKey: string | null,
): { allies: Set<string> | null; axis: Set<string> | null; ends: "x" | "y" | null } | null {
  if (!config.containEnabled || !zoneKey) return null;
  const z = (config.containZones ?? {})[zoneKey];
  if (!z || !(z.allies?.length || z.axis?.length || z.shared?.length)) return null;
  const shared = new Set(z.shared ?? []);
  const groundOf = (own: string[] | undefined, other: string[] | undefined): Set<string> | null => {
    const theirs = new Set(other ?? []);
    const s = new Set((own ?? []).filter((c) => !shared.has(c) && !theirs.has(c)));
    return s.size ? s : null;
  };
  return { allies: groundOf(z.allies, z.axis), axis: groundOf(z.axis, z.allies), ends: paintAxis(z) };
}

/**
 * Is this weapon disallowed while seeding? Class chips first ("no artillery" keeps matching when a
 * patch adds a new gun to the family), then individual names picked from the game's own weapon
 * table (exact match, case-insensitive — a picked name IS what the kill line says), then the
 * free-text extras as case-insensitive substrings — the same matching the retired Seeding rules
 * module used, so a carried-over list behaves identically.
 */
export function isDisallowedWeapon(
  config: Pick<SeedingConfigRow, "disallowedWeaponClasses" | "disallowedWeapons" | "disallowedWeaponNames">,
  classId: string | null,
  weapon: string,
): boolean {
  if (classId && (config.disallowedWeaponClasses ?? []).includes(classId)) return true;
  const w = weapon.toUpperCase();
  if ((config.disallowedWeaponNames ?? []).includes(w)) return true;
  return (config.disallowedWeapons ?? []).some((sub) => sub && w.includes(sub));
}

/** Is this kill a blocked commander ability? Exact match against the config's upper-cased list —
 *  ability names come from the game table, so there is nothing fuzzy to allow for. */
export function isDisallowedCommanderAbility(
  config: Pick<SeedingConfigRow, "disallowedCommanderAbilities">,
  weapon: string,
): boolean {
  return (config.disallowedCommanderAbilities ?? []).includes(weapon.toUpperCase());
}

/**
 * What the seed reward is, in words — for `{reward}` in the reward message and for the audit row.
 *
 * The reward has two independent halves and every combination is legitimate, so one message has to
 * read correctly whichever are switched on. Composing the phrase here rather than making staff
 * write three messages is what makes "either or both" a setting rather than a rewrite: turning
 * points on does not silently leave a message saying "you've been granted 24h of VIP" when the
 * grant was 500 points.
 *
 * Returns "" when nothing is being given, so a caller can tell "no reward" from "a reward of
 * nothing" — the route refuses to store the latter, but a config written before that rule existed
 * still has to render.
 */
// One implementation for every message the app sends (see @app/db placeholders).
export { vipSpan, formatVipUntil } from "@app/db";

export function rewardPhrase(hours: number, points: number, currencyName: string): string {
  const parts: string[] = [];
  if (hours > 0) parts.push(`${vipSpan(hours)} of VIP`);
  if (points > 0) parts.push(`${points} ${currencyName}`);
  return parts.join(" and ");
}

/** Everything the seed reward has to say to ONE player, and what actually happened to them. */
export interface RewardTell {
  playerName: string;
  /** VIP hours the config gives (0 = no VIP half). */
  hours: number;
  /** Points the config gives a qualifying seeder (0 = no points half). */
  points: number;
  /** Whether this player's game account carries a Discord link — where points can land. */
  linked: boolean;
  /** What was actually credited; the balance cap may have trimmed it. Null when nothing was. */
  credited: number | null;
  /** Their balance after the credit. Null when they have none. */
  balance: number | null;
  currencyName: string;
  /** When this player's VIP on THIS server now runs out, already formatted for reading
   *  ("Oct 3, 7:45 PM EDT") — CRCON's seeding reward says this, so ours does too. Null when
   *  there is nothing to date: no VIP half, or the grant is permanent. */
  vipUntil?: string | null;
  /** The VIP half was absorbed by a PERMANENT grant — nothing was written, on purpose, and the
   *  player deserves a word about it instead of the silence they used to get. */
  vipAbsorbed?: boolean;
  /** `config.rewardMessage`, `config.rewardLinkedNote`, `config.rewardUnlinkedNote`. */
  message: string;
  linkedNote: string;
  unlinkedNote: string;
}

/**
 * What the seed reward tells one player — the whole sentence, or nothing.
 *
 * TWO PIECES, and they answer different people. The reward line is sent only when something
 * actually reached them: with an empty phrase it would be a sentence with a hole in it ("You've
 * been granted ."), which is worse than silence. The currency footnote is sent whenever points are
 * switched on AT ALL, because it is the half that speaks to the seeder who got nothing — points
 * land on a Discord account, so an unlinked seeder collects the VIP half and would otherwise never
 * learn a currency reward exists. It says what they COULD have earned, which is true, and is the
 * reason to go and link.
 *
 * Numbers are the ones that happened: a linked player is told what was CREDITED (the cap may have
 * trimmed it) and the balance it produced; an unlinked one is told the configured amount, because
 * that is what they would have had. `{balance}` renders as nothing for them rather than as a zero
 * somebody could mistake for their total.
 */
export function composeRewardMessage(t: RewardTell): string {
  const theirs = t.points > 0 && t.linked ? t.points : 0;
  const phrase = rewardPhrase(t.hours, theirs, t.currencyName);
  const note = t.points > 0
    ? applyVars(t.linked ? t.linkedNote : t.unlinkedNote, {
      player_name: t.playerName, currency: t.currencyName,
      reward_points: t.linked ? (t.credited ?? theirs) : t.points,
      balance: t.linked ? (t.balance ?? 0) : "",
    }).trim()
    : "";
  // The expiration rides the message like the restriction lists ride the greeting: a placed
  // {vip_until} token is the operator saying where it belongs; with no token it is appended as
  // its own sentence, because "you now have VIP until X" should not depend on remembering one.
  const until = t.hours > 0 ? (t.vipUntil ?? "").trim() : "";
  const template = until && !t.message.includes("{vip_until}")
    ? `${t.message.trim()} Your VIP on this server runs until {vip_until}.`
    : t.message;
  const body = phrase
    ? applyVars(template, {
      player_name: t.playerName, reward_hours: t.hours, reward_points: theirs,
      currency: t.currencyName, reward: phrase, vip_until: until,
    }).trim()
    : "";
  // A permanent VIP's reward is absorbed by design (a paid grant is never rewritten) — but the
  // absorb used to be SILENT when points were off, and "I seeded and got nothing" is exactly
  // what that silence reads as. Thank them and say why there was nothing to add.
  const absorbed = t.vipAbsorbed
    ? (phrase ? "(Your VIP is permanent, so the VIP part had nothing to add.)"
      : `Thanks for helping us seed, ${t.playerName}! Your VIP is permanent, so there was nothing to add.`)
    : "";
  return [body, note, absorbed].filter(Boolean).join(" ");
}

/**
 * Why the POINTS half of a seed reward did not land — or null when it did (or was never offered).
 *
 * There are two ways for points to miss, and only one of them is the player's to fix. "We looked,
 * and you have no Discord account linked" is worth telling them, with the note that says where to
 * link one. "We could not look" is not: it earns them nothing, it is ours to fix, and telling
 * somebody who linked their account months ago that they missed out for not linking it is worse
 * than saying nothing. They used to be the same branch, because a failed lookup returned the same
 * empty answer as a genuine absence.
 */
export function pointsSkipReason(input: { points: number; discordId: string | null; linkReadable: boolean }): string | null {
  if (input.points <= 0 || input.discordId) return null;
  return input.linkReadable
    ? "no Discord link — points have no balance to land on"
    : POINTS_LINK_UNREADABLE;
}

/**
 * Which account a BRIDGE slice lands on — or why it cannot.
 *
 * A same-game target is the easy half: the two servers speak the same platform ids, so the
 * seeder's own id is the answer and no registration is asked for. A target on ANOTHER game has
 * no shared id — the games issue different ones — so the only honest join is the one that
 * registration built: the seeded account's Discord link is the hub, and the other game's link
 * supplies the id that game understands. That is exactly how the VIP shop lands a purchase on
 * both games, reused here rather than re-invented.
 *
 * The two kinds of missing are kept apart the way pointsSkipReason keeps them: "not registered"
 * is the seeder's to fix and worth telling them; "we could not look" is ours, and telling
 * somebody who linked months ago that they are unlinked is worse than saying nothing.
 */
export function bridgeAccountFor(input: {
  targetGame: string;
  seededGame: string;
  seederPlatformId: string;
  /** every game account the seeder's Discord holds; [] = no Discord link; null = could not READ. */
  linkedAccounts: { game: string; platformId: string }[] | null;
  /** the target game's display label, for the skip reason a player may be shown. */
  gameLabel: string;
}): { playerId: string; skipped: null } | { playerId: null; skipped: string } {
  if (input.targetGame === input.seededGame) return { playerId: input.seederPlatformId, skipped: null };
  if (input.linkedAccounts === null) return { playerId: null, skipped: "could not read this seeder's links — bridge VIP not paid this round" };
  if (!input.linkedAccounts.length) return { playerId: null, skipped: `no Discord link — registering for ${input.gameLabel} is what bridges the games` };
  const account = input.linkedAccounts.find((a) => a.game === input.targetGame);
  if (!account) return { playerId: null, skipped: `not registered for ${input.gameLabel} — bridge VIP has no account to land on there` };
  return { playerId: account.platformId, skipped: null };
}

/**
 * The bridge sentence appended to a seeder's reward message — the landings AND the misses.
 *
 * Landed slices were always announced; the misses were silent, and a seeder who configured their
 * expectations from the panel ("seed here, get a day there") read that silence as a reward that
 * failed. The rule for which misses speak is pointsSkipReason's, applied per slice: a miss the
 * PLAYER can fix (no Discord link, not registered for the other game, VIP already permanent
 * there) is told to them with its reason; a miss that is OURS to fix — an unreadable link, a
 * target that refused or could not be reached, a stop whose server no longer resolves — passes
 * `tell: null` and stays out of the message entirely, because "you missed out for not linking"
 * sent to somebody who linked months ago is worse than saying nothing. The audit row carries
 * every miss either way.
 */
export function bridgeBonusLine(slices: { server: string | null; hours: number; landed: boolean; tell: string | null }[]): string {
  const landed = slices.filter((s) => s.landed).map((s) => `${vipSpan(s.hours)} VIP on ${s.server ?? "a linked server"}`);
  const missed = slices.filter((s) => !s.landed && s.tell).map((s) => `no bridge VIP on ${s.server ?? "a linked server"} (${s.tell})`);
  const parts: string[] = [];
  if (landed.length) parts.push(`Bridge bonus: ${landed.join(", ")}.`);
  if (missed.length) parts.push(`Heads up: ${missed.join("; ")}.`);
  return parts.join(" ");
}

/**
 * Compute a seed-reward VIP expiration from the CURRENT GRANT ROW — or null, meaning LEAVE THE
 * ROW ALONE, the grant already outlasts anything a reward could add.
 *
 * `existing` is the row, not its expiration, and the difference is a paid grant's life. A
 * permanent VIP stores `expiration: null`, and so does the absence of a grant, so this function
 * used to be handed only the expiration and read "VIP forever" as "no VIP": a seeder holding
 * PAID permanent VIP had it replaced with now + the reward hours, and three days later the
 * expiry sweep — correctly enforcing the date it found — removed the grant from the game. The
 * reward for helping seed was losing VIP bought with real money, and every later seed round
 * re-granted the reward hours over the hole, which is what made it look like "seed VIP" rather
 * than a deletion.
 *
 * The shop fixed this exact bug once before (computeGrantExpiration in the API's kit.ts —
 * "permanent absorbs the days; adding time never subtracts any"). This is the reward path's
 * copy of the same rule; the two live in different apps, so each carries the test that keeps
 * it honest.
 *
 * Dated grants are NEVER shortened either: cumulative stacks the hours onto the later of the
 * current expiry and now; non-cumulative takes the later of the current expiry and now + hours.
 */
export function calcRewardExpiration(existing: { expiration: string | null } | null | undefined, hours: number, cumulative: boolean, nowMs: number): string | null {
  if (existing && existing.expiration === null) return null; // permanent absorbs the reward
  const add = hours * 3_600_000;
  const prior = existing?.expiration ? Date.parse(existing.expiration) : null;
  if (prior === null || Number.isNaN(prior)) return new Date(nowMs + add).toISOString();
  if (cumulative) return new Date(Math.max(prior, nowMs) + add).toISOString();
  return new Date(Math.max(prior, nowMs + add)).toISOString();
}

/**
 * How long the runner sleeps before its next tick.
 *
 * The slow poll is right for most of what seeding is — counting heads, watching the phase,
 * checking roles: none of that changes meaningfully inside half a minute. The cap fight and
 * containment are different in kind: they are CHASES, where the violation is a player physically
 * somewhere they shouldn't be, and at thirty seconds a wave of attackers spawning off an edge OP
 * delivers the final cap BETWEEN ticks. (The field report was precise about what that looks like:
 * "punishes like one person at a time every 30 or so seconds" — one detection per slow tick,
 * while the wave caps the point.) So while a chase rule is armed and the server is actually
 * seeding, the loop ticks fast; every other phase keeps the slow poll's lighter touch.
 */
/**
 * The sleep before the next tick, with this server's own check speeds (set in the app) over the
 * install's defaults. Blank in the app = the default.
 */
export function seedCheckDelayMs(
  phase: Phase,
  config: Pick<SeedingConfigRow, "capFightEnabled" | "containEnabled" | "checkSec" | "chaseCheckSec">,
  defaults: { fastMs: number; slowMs: number },
  /** the pace rule is armed this tick — it follows positions in LIVE rounds too, where the
   *  seeding rules are done, and a push checked every 30s is a push caught after it capped. */
  paceArmed = false,
): number {
  const slowMs = config.checkSec ? config.checkSec * 1000 : defaults.slowMs;
  const fastMs = config.chaseCheckSec ? config.chaseCheckSec * 1000 : defaults.fastMs;
  if (paceArmed) return Math.min(fastMs, slowMs);
  return seedTickDelayMs(phase, config, fastMs, slowMs);
}

export function seedTickDelayMs(
  phase: Phase,
  config: Pick<SeedingConfigRow, "capFightEnabled" | "containEnabled">,
  fastMs: number,
  slowMs: number,
): number {
  if (phase !== "seeding") return slowMs;
  // The zones chase with or without paint: where nothing is painted, the auto fence watches.
  const chasing = config.capFightEnabled || config.containEnabled;
  return chasing ? Math.min(fastMs, slowMs) : slowMs;
}

/**
 * Whether a tick's phase is news for staff (the phone's seeding notification): a change of the
 * committed phase, once the phase machine has settled since its last reset. After a reset (start,
 * reconnect, re-enable) "idle" is a placeholder and the phase finds its feet within a confirm
 * window; that first settled phase is learned in silence, or a worker restarting mid-seed would
 * announce that seeding had started, and a minute later a server already live would "go live".
 */
export function seedingNews(
  state: { settled: boolean; prevPhase: Phase },
  plan: { phase: Phase; pendingPhase: Phase | null },
): { news: boolean; settled: boolean } {
  return { news: state.settled && plan.phase !== state.prevPhase, settled: state.settled || plan.pendingPhase === null };
}

/**
 * Who joined a server since `cursor`, the seeding announcement's audience: its connect events
 * after the cursor, by game id (the id the roster and every RCON command speak; the store keys
 * events by our own), and the cursor to read from next. A join the store cannot name a game id
 * for is passed over rather than greeted under the wrong id.
 */
export async function joinsSince(
  repo: Pick<Repository, "events" | "players">,
  serverId: string,
  cursor: string,
): Promise<{ joined: { playerId: string; name: string }[]; cursor: string }> {
  const rows = await repo.events.query({ serverId, kinds: ["evt.player.connected"], from: cursor, limit: 200 }).catch(() => []);
  const fresh = rows.filter((e) => e.ts > cursor && e.actorPlayerId);
  let next = cursor;
  for (const e of fresh) if (e.ts > next) next = e.ts;
  if (!fresh.length) return { joined: [], cursor: next };
  const players = await repo.players.findByIds([...new Set(fresh.map((e) => e.actorPlayerId!))]).catch(() => []);
  const platformByDbId = new Map(players.map((pl) => [pl.id, pl.platformId]));
  const joined = fresh.flatMap((e) => {
    const playerId = platformByDbId.get(e.actorPlayerId!);
    return playerId ? [{ playerId, name: e.actorName ?? "" }] : [];
  });
  return { joined, cursor: next };
}

/** What the reward rows say actually LANDED for one seeder, part by part. */
export interface SeedPaidParts { vip: boolean; points: boolean }

/** A points half we could not pay because the seeder's Discord link was unreadable — OURS to owe.
 *  (No link at all is the player's to fix, and counts as done.) */
export const POINTS_LINK_UNREADABLE = "could not read this seeder's Discord link — points not paid this round";

/**
 * What each seeder was PAID within the rows given: real rounds only — a dry run paid nobody, a
 * failed grant paid nobody, and a bridge landing is another server's seed. Part by part, because
 * a receipt can record a round that paid the points while the game refused the VIP: that seeder
 * is still OWED the VIP, and must not be told "you were already rewarded" on the next go-live.
 * Any row that landed a part counts for that part.
 */
export function seedPaidPlayers(rows: { targetId?: string | null; data?: unknown }[]): Map<string, SeedPaidParts> {
  const paid = new Map<string, SeedPaidParts>();
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (!r.targetId || d.dryRun || d.failed || d.bridgeFrom) continue;
    const vip = !d.vipFailed;
    const points = !(d.pointsOwed === true || d.pointsSkipped === POINTS_LINK_UNREADABLE);
    const had = paid.get(r.targetId);
    paid.set(r.targetId, { vip: vip || (had?.vip ?? false), points: points || (had?.points ?? false) });
  }
  return paid;
}

/**
 * A round's qualifying seeders, split three ways by what the repeat window already paid them:
 *   - nothing → paid in full, like any seeder;
 *   - everything → THANKED, not paid again ("the server is seeded — you already got this");
 *   - part of it (the game refused their VIP last time) → paid the missing part only, via the same
 *     skip flags a retry uses. The bridge is skipped for them: it ran on the earlier round, and a
 *     second run would stack its VIP twice.
 */
export function splitRepeatSeeders<T extends { playerId: string; skipVip?: boolean; skipPoints?: boolean; skipBridge?: boolean }>(
  qualified: T[], paidRecently: Map<string, SeedPaidParts>,
): { pay: T[]; repeat: T[] } {
  const pay: T[] = [];
  const repeat: T[] = [];
  for (const q of qualified) {
    const parts = paidRecently.get(q.playerId);
    if (!parts) pay.push(q);
    else if (parts.vip && parts.points) repeat.push(q);
    else pay.push({ ...q, skipVip: q.skipVip || parts.vip, skipPoints: q.skipPoints || parts.points, skipBridge: true });
  }
  return { pay, repeat };
}

/** A repeat window the way a player reads it: "1 hour", "90 minutes", "2 hours". */
export function seedWindowLabel(sec: number): string {
  const min = Math.round(sec / 60);
  if (min >= 60 && min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return min === 1 ? "1 minute" : `${min} minutes`;
}
