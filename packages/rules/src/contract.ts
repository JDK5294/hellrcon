/**
 * Shared shapes for the roster-state triggers. Once the contract for standalone "automod modules";
 * the module framework (its registry, standard config and escalation runner) retired when the
 * scenarios became Rules-engine triggers — the enforcer owns escalation, immunity and messaging
 * now. What remains is the vocabulary the detectors, the API's param validation and the panel's
 * param editor still share.
 */

/** One live player as detectors see them (the worker normalizes the raw roster onto this). */
export interface RulePlayer {
  playerId: string;
  name: string;
  level: number;
  role: number;
  team: number;
  /** squad/platoon name ("" if the player is not in a squad). */
  squad: string;
  loadout: string;
  /** our custom tags on this player; empty if none / not resolved. */
  tags: string[];
  /** live world position; null when the roster carried none, or the player is on the deploy
   *  screen (the game reports exactly (0,0) there). Only the zone trigger reads it. */
  pos?: { x: number; y: number } | null;
  /**
   * Whether this player holds VIP on this server right now — a grant of ours that is permanent,
   * still dated in the future or PAUSED, or an entry on the game's own VIP list. null/undefined =
   * not known this tick (the game's list could not be read, or no rule asked): a trigger that
   * reads it must treat unknown as "has VIP" and say nothing. Only the no-VIP trigger reads it.
   */
  vip?: boolean | null;
  /** Where a `vip: true` came from — a grant in the panel, or only the game's own list. Only the
   *  no-VIP trigger's status breakdown reads it. */
  vipSource?: "grant" | "game" | null;
  /** Minutes this player has been on the server, as far as this worker has watched them (a
   *  restart starts the clock again — the direction that acts later, never sooner). */
  onlineMinutes?: number | null;
  /** This match's kills (infantry + vehicle), deaths and team kills, as the roster reports them. */
  kills?: number | null;
  deaths?: number | null;
  teamkills?: number | null;
  /** Minutes they have been playing THIS match: the lesser of time since first seen and time since
   *  the match started (null = unknown). The kill-rate trigger's time base. */
  playMinutes?: number | null;
  /** Whether a Discord account is linked to this player; null = not known this tick. Only the
   *  no-Discord-link trigger reads it, and unknown never reads as "not linked". */
  discordLinked?: boolean | null;
  /** Hours played, keyed by playtimeKey(allServers, periodDays) — one entry per distinct
   *  playtime rule shape enabled on the server. Absent key = not known this tick. */
  playtimeHours?: Record<string, number>;
  /** The clan tag the roster shows for them, exactly as typed ("" = none). Only the clan tag
   *  trigger reads it. */
  clanTag?: string;
}

/** A param field — drives both the rule editor's param form and server-side validation.
 *  `list` is a list of strings (the clan tag trigger's chosen tags); `number` is a decimal (a
 *  ratio's limit), kept to two places. */
export type RuleFieldType = "bool" | "int" | "number" | "text" | "roles" | "list";
export interface RuleField {
  key: string;
  label: string;
  type: RuleFieldType;
  default: boolean | number | string | number[];
  help?: string;
  min?: number;
  max?: number;
  /** legacy UI grouping; unused by the rule editor but kept for field-shape compatibility. */
  group?: string;
}

/** A detected violation: who, and the sentence that fills the `{violation}` message token. */
export interface Violation {
  playerId: string;
  name: string;
  reason: string;
}
