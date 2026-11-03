/**
 * Canonical, game-agnostic event taxonomy (`evt.*`).
 *
 * The normalizer turns raw game log lines into these typed events. Every downstream
 * consumer (stats, enforcer, alerts, plugins) reads `evt.*` — never raw log strings —
 * so the system stays independent of any one game/version's log format.
 *
 * NOTE: our own prefix is `evt.*`. Do not adopt any third-party event naming.
 */

export type EvtKind =
  | "evt.player.connected"
  | "evt.player.disconnected"
  | "evt.player.teamSwitched"
  | "evt.chat.team"
  | "evt.chat.squad"
  | "evt.kill"
  | "evt.teamkill"
  | "evt.match.started"
  | "evt.match.ended"
  | "evt.vote.started"
  | "evt.vote.completed"
  | "evt.player.kicked"
  | "evt.player.banned"
  | "evt.player.punished"
  | "evt.admin.message"
  // Both arrive through the CRCON import rather than the live HLL log, which is how they came to
  // be missing here while the store had them: nothing typed against this union could describe an
  // event the system was already keeping. The db's EVENT_KINDS is the runtime list and a test now
  // asserts the two agree.
  | "evt.admin.camera"
  | "evt.vote.cast";

export interface BaseEvt<K extends EvtKind = EvtKind> {
  kind: K;
  serverId: string;
  ts: string; // ISO 8601
  /** free-form extras preserved from the log line (reason, message, vote type, …). */
  data?: Record<string, unknown> | null;
}

export interface PlayerEvt<K extends EvtKind = EvtKind> extends BaseEvt<K> {
  playerId?: string;
  playerName?: string;
}

export interface KillEvt extends PlayerEvt<"evt.kill" | "evt.teamkill"> {
  victimId?: string;
  victimName?: string;
  weapon?: string;
}

/** A moderation action from the admin log (kick/ban/punish, including auto-TK enforcement). */
export interface ModerationEvt extends PlayerEvt<"evt.player.kicked" | "evt.player.banned" | "evt.player.punished"> {
  reason?: string;
  banType?: "temp" | "perma";
  auto?: boolean; // server-side auto action (e.g. team-kill auto kick/ban)
}

/** A vote-system event (start/complete). */
export interface VoteEvt extends PlayerEvt<"evt.vote.started" | "evt.vote.completed"> {
  target?: string;
  voteType?: string;
  result?: string;
}

export type Evt = BaseEvt | PlayerEvt | KillEvt | ModerationEvt | VoteEvt;

/** Package marker export. Live event distribution is @app/bus; this package owns the shared event TYPES. */
export const EVENT_TAXONOMY_VERSION = 1 as const;
