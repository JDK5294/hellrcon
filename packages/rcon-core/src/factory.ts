/**
 * Adapter factory + guarded client construction.
 *
 * `createServerClient` is the one entry point callers should use: it picks the protocol
 * adapter and wraps it in the engagement-mode guard, so a server that isn't explicitly
 * `active` physically cannot issue writes.
 */
import type { EngagementMode, RconProtocol } from "@app/shared";
import { guardEngagement } from "./engagement.js";
import type { CommandTable, RconAdapter } from "./types.js";
import { BinaryV2Adapter } from "./protocol/binary-v2/adapter.js";
import { LegacyTextAdapter } from "./protocol/legacy-text/adapter.js";
import { CrconBridgeAdapter } from "./protocol/crcon-bridge/adapter.js";

export function createAdapter(protocol: RconProtocol, commands: CommandTable = {}, lineKey?: (line: string) => string): RconAdapter {
  switch (protocol) {
    case "binary-v2":
      return new BinaryV2Adapter(commands, lineKey);
    case "legacy-text":
      return new LegacyTextAdapter(commands, lineKey);
    case "crcon-bridge":
      return new CrconBridgeAdapter(commands, lineKey);
    default: {
      const never: never = protocol;
      throw new Error(`Unknown protocol: ${String(never)}`);
    }
  }
}

export interface ServerClientOptions {
  protocol: RconProtocol;
  /** defaults to `observe` — safe alongside an existing CRCON. */
  engagementMode?: EngagementMode;
  /** the game's logical-command table (from its game module). Without one, every logical
   *  command is unknown — reads fail fast and observe mode refuses everything. */
  commands?: CommandTable;
  /** the game's stable log-line identity (for stream dedup); defaults to the raw line. */
  lineKey?: (line: string) => string;
}

/** Build a ready-to-use, engagement-guarded adapter for a server. */
export function createServerClient(opts: ServerClientOptions): RconAdapter {
  const adapter = createAdapter(opts.protocol, opts.commands ?? {}, opts.lineKey);
  return guardEngagement(adapter, opts.engagementMode ?? "observe");
}
