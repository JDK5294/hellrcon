/**
 * @app/rcon-core — owns ALL game I/O. Nothing else in the system opens a game socket.
 *
 * - Pluggable protocol adapters, all three implemented: binary-v2 (the current HLL protocol),
 *   legacy-text (the older line protocol, for servers not yet on v2), and crcon-bridge (talks to an
 *   existing CRCON instance over HTTP instead of the game socket, for running alongside one).
 *   A command a protocol cannot express is refused by name rather than silently doing nothing.
 * - Logical commands resolve against a game module's injected command table (game-agnostic core).
 * - Engagement-mode guard keeps `observe` servers strictly read-only.
 */
export type { RconAdapter, ServerConn, StateKind, StreamOptions, Unsubscribe, CommandAccess, CommandDef, CommandTable, BinaryV2Wire, LegacyTextWire } from "./types.js";
export { createAdapter, createServerClient } from "./factory.js";
export type { ServerClientOptions } from "./factory.js";
export { guardEngagement, ObserveModeViolation } from "./engagement.js";
export { BinaryV2Connection, RconConnectionError, RconCommandError } from "./protocol/binary-v2/connection.js";
export { MAGIC_HEADER_VALUE } from "./protocol/binary-v2/frame.js";
export type { HeaderMode } from "./protocol/binary-v2/frame.js";
export { serverNameFromSession } from "./server-name.js";
export { normalizeSession, queueDepth, vipQueueDepth } from "./session.js";
export type { SessionInfo } from "./session.js";
export { normalizeGameBans, normalizeGameVips, type GameVip } from "./protocol/binary-v2/responses.js";
export { planVipReconcile, vipReconcileSignature, type VipGrantLike, type VipReconcilePlan } from "./vip-reconcile.js";
export { messageEveryone, MESSAGE_PACE_MS, rosterPlayerIds, rosterPlayers, type MessageAllClient, type MessageAllOptions, type MessageAllResult } from "./broadcast-all.js";
// The CRCON HTTP client is also usable directly (e.g. importing an existing CRCON's stored data),
// not only through the bridge protocol.
export { CrconClient, CrconBridgeError } from "./protocol/crcon-bridge/client.js";
export type { CrconClientOptions } from "./protocol/crcon-bridge/client.js";
export type {
  GameBan,
  V2BanEntry,
  V2BanList,
  V2PlayerInfo,
  V2PlayersResponse,
  V2SessionInfo,
  V2MapEntry,
  V2MapRotation,
  V2ScoreData,
  V2PlayerStats,
} from "./protocol/binary-v2/responses.js";
