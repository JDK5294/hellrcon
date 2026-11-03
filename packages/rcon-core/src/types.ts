/**
 * rcon-core public contracts. Everything above rcon-core speaks *logical* commands and
 * `StateKind` reads — never a wire protocol. Adapters translate to the right protocol.
 *
 * rcon-core is game-agnostic: it defines the *shape* of a command table (below) but ships no
 * command data. A game module (see @app/games) supplies the table; adapters receive it by
 * injection. Game tables in @app/games satisfy these types structurally.
 */
import type { RconProtocol } from "@app/shared";
import type { HeaderMode } from "./protocol/binary-v2/frame.js";

export type StateKind = "players" | "session" | "objectives" | "maprotation";

// ---- command wire contracts (data supplied per game) ----

export type CommandAccess = "read" | "write";

export interface BinaryV2Wire {
  /** v2 command name on the wire. */
  name: string;
  /** protocol/command version negotiated with the server. */
  version: number;
  /** builds the `contentBody` from logical params — usually a JSON object, but a few v2 commands
   *  (e.g. GetClientReferenceData) take a bare string body. */
  content: (params: Record<string, unknown>) => Record<string, unknown> | string;
}

/** Legacy text protocol: a command is a single line of text. */
export interface LegacyTextWire {
  /** builds the text command line sent over the socket. */
  build: (params: Record<string, unknown>) => string;
}

export interface CommandDef {
  logical: string;
  access: CommandAccess;
  binaryV2?: BinaryV2Wire;
  legacyText?: LegacyTextWire;
}

/** A game's full logical-command table (e.g. HLL's HLL_BINARY_V2). */
export type CommandTable = Record<string, CommandDef>;

export interface ServerConn {
  host: string;
  port: number;
  password: string;
  /** binary-v2 only: header framing variant. Defaults to `magic`. */
  headerMode?: HeaderMode;
  /** crcon-bridge only: base URL of an existing CRCON instance. */
  crconBaseUrl?: string;
  timeoutMs?: number;
}

export interface StreamOptions {
  /** poll interval for log tailing (ms). */
  intervalMs?: number;
}

/** Unsubscribe handle returned by streamLogs. */
export type Unsubscribe = () => void;

/** A raw, un-abstracted RCON command for the admin console. For binary-v2, `command` is the v2
 *  command name and `body`/`version` are its content-body/version; for legacy-text, `command` is
 *  the full text line (version/body ignored); for crcon-bridge, `command` is a CRCON API path. */
export interface RawCommand {
  command: string;
  version?: number;
  body?: unknown;
}
export interface RawResult {
  statusCode?: number;
  statusMessage?: string;
  content: string;
}

export interface RconAdapter {
  readonly protocol: RconProtocol;
  /** whether this adapter can issue state-changing commands at all (crcon-bridge is read-mostly). */
  readonly canWrite: boolean;
  /** the game's command table this adapter resolves logical commands against. */
  readonly commands: CommandTable;
  connect(conn: ServerConn): Promise<void>;
  disconnect(): Promise<void>;
  /** run a logical command; returns parsed content (object if JSON, else string). */
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  /** convenience read of a known server-info state. */
  readState(kind: StateKind): Promise<unknown>;
  /** one-shot read of recent admin-log lines (last `seconds`). */
  readLogLines(seconds?: number): Promise<string[]>;
  /** tail admin-log lines; each raw line should be fed to the normalizer by the caller. */
  streamLogs(onLine: (raw: string) => void, opts?: StreamOptions): Unsubscribe;
  /** send a raw command (admin console). Bypasses the logical registry; the engagement guard
   *  refuses it on observe servers (it can't classify an arbitrary command). */
  raw(input: RawCommand): Promise<RawResult>;
}
