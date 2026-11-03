/**
 * binary-v2 adapter — implements the RconAdapter contract over BinaryV2Connection,
 * resolving logical commands through the registry.
 *
 * Log streaming is poll-based for Phase 1: it periodically reads the admin log and emits
 * only newly-seen lines. (A push/watch transport can replace this behind the same API.)
 */
import { BinaryV2Connection, RconCommandError } from "./connection.js";
import type { CommandDef, CommandTable, RconAdapter, ServerConn, StateKind, StreamOptions, Unsubscribe } from "../../types.js";

const STATE_TO_COMMAND: Record<StateKind, string> = {
  players: "getPlayers",
  session: "getSession",
  objectives: "getObjectives",
  maprotation: "getMapRotation",
};

function parseContent(content: string): unknown {
  if (!content) return "";
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

export class BinaryV2Adapter implements RconAdapter {
  readonly protocol = "binary-v2" as const;
  readonly canWrite = true;
  private conn: BinaryV2Connection | null = null;

  /** the game module's command table (logical → wire); injected so the adapter stays game-agnostic. */
  constructor(
    readonly commands: CommandTable = {},
    /** stable per-event line identity for stream dedup (game modules supply theirs). */
    private readonly lineKey: (line: string) => string = (l) => l,
  ) {}

  private def(command: string): CommandDef {
    const def = this.commands[command];
    if (!def) throw new Error(`Unknown logical command: ${command}`);
    return def;
  }

  async connect(conn: ServerConn): Promise<void> {
    this.conn = new BinaryV2Connection({
      host: conn.host,
      port: conn.port,
      password: conn.password,
      headerMode: conn.headerMode,
      timeoutMs: conn.timeoutMs,
    });
    await this.conn.connect();
  }

  async disconnect(): Promise<void> {
    this.conn?.close();
    this.conn = null;
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.conn) throw new Error("adapter not connected");
    const def = this.def(command);
    const wire = def.binaryV2;
    if (!wire) throw new Error(`command '${command}' is not mapped for binary-v2 yet (the v2 server enumerates its commands via GetDisplayableCommands)`);
    const res = await this.conn.exchange(wire.name, wire.version, wire.content(params));
    if (res.statusCode !== 200) {
      // Typed, not a bare Error: the server ANSWERED and said no. Callers must be able to tell
      // "the game refused this command" (a fact about the request — the player is offline, the
      // id is wrong) from "the connection is dead" (a fact about the server), because only the
      // second is fixed by reconnecting — and only the second is a gateway's fault to report.
      throw new RconCommandError(res.statusCode, `command ${command} failed: ${res.statusMessage}`);
    }
    return parseContent(res.content);
  }

  async raw(input: { command: string; version?: number; body?: unknown }): Promise<{ statusCode?: number; statusMessage?: string; content: string }> {
    if (!this.conn) throw new Error("adapter not connected");
    const content = input.body == null ? {} : (input.body as Record<string, unknown> | string);
    const res = await this.conn.exchange(input.command, input.version ?? 2, content);
    return { statusCode: res.statusCode, statusMessage: res.statusMessage, content: res.content };
  }

  readState(kind: StateKind): Promise<unknown> {
    return this.execute(STATE_TO_COMMAND[kind]);
  }

  async readLogLines(seconds = 65): Promise<string[]> {
    const result = await this.execute("getAdminLog", { seconds });
    return extractLogLines(result);
  }

  streamLogs(onLine: (raw: string) => void, opts: StreamOptions = {}): Unsubscribe {
    const intervalMs = opts.intervalMs ?? 5_000;
    const seen = new Set<string>();
    let stopped = false;

    const tick = async () => {
      if (stopped || !this.conn) return;
      try {
        const lines = await this.readLogLines(Math.ceil(intervalMs / 1000) + 5);
        for (const line of lines) {
          const key = this.lineKey(line); // stable across polls (relative time in the prefix changes)
          if (seen.has(key)) continue;
          seen.add(key);
          onLine(line);
        }
        // keep the dedup set bounded
        if (seen.size > 5000) seen.clear();
      } catch {
        // transient read failure; next tick retries
      }
    };

    const handle = setInterval(() => void tick(), intervalMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}

/** Defensive extraction of log message strings from the (best-effort) GetAdminLog shape. */
function extractLogLines(result: unknown): string[] {
  if (typeof result === "string") return result.split(/\r?\n/).filter(Boolean);
  if (result && typeof result === "object") {
    const entries = (result as Record<string, unknown>).entries ?? (result as Record<string, unknown>).Entries ?? (result as Record<string, unknown>).logs;
    if (Array.isArray(entries)) {
      return entries
        .map((e) => (typeof e === "string" ? e : ((e as Record<string, unknown>)?.message ?? (e as Record<string, unknown>)?.Message ?? "")))
        .map((s) => String(s))
        .filter(Boolean);
    }
  }
  return [];
}
