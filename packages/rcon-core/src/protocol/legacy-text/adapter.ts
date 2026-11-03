/**
 * legacy-text adapter — HLL's older text-based RCON protocol, over the XOR-framed TCP
 * transport (LegacyTextConnection). Logical commands resolve through the registry's
 * `legacyText` wire; commands the legacy protocol doesn't support throw a clear error.
 *
 * Reads parse the tab/newline responses; writes expect `SUCCESS`. Log tailing is poll-based,
 * same as the other adapters, and emits each new raw line for the normalizer.
 */
import { LegacyTextConnection } from "./connection.js";
import { parsePlayerIds, parseShowLog } from "./parse.js";
import type { CommandDef, CommandTable, RconAdapter, ServerConn, StateKind, StreamOptions, Unsubscribe } from "../../types.js";

export class LegacyTextAdapter implements RconAdapter {
  readonly protocol = "legacy-text" as const;
  readonly canWrite = true;
  private conn: LegacyTextConnection | null = null;

  /** the game module's command table; injected so the adapter stays game-agnostic. */
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
    this.conn = new LegacyTextConnection({ host: conn.host, port: conn.port, password: conn.password, timeoutMs: conn.timeoutMs });
    await this.conn.connect();
  }

  async disconnect(): Promise<void> {
    this.conn?.close();
    this.conn = null;
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.conn) throw new Error("adapter not connected");
    const def = this.def(command);
    if (!def.legacyText) throw new Error(`command '${command}' is not supported on the legacy-text protocol`);

    const resp = await this.conn.send(def.legacyText.build(params));

    if (def.access === "write") {
      if (resp.trim().toUpperCase().startsWith("SUCCESS")) return { ok: true };
      throw new Error(`command ${command} failed: ${resp.trim() || "(no response)"}`);
    }
    if (command === "getPlayers") return parsePlayerIds(resp);
    if (command === "getAdminLog") return parseShowLog(resp);
    return resp;
  }

  async raw(input: { command: string }): Promise<{ content: string }> {
    if (!this.conn) throw new Error("adapter not connected");
    return { content: await this.conn.send(input.command) };
  }

  readState(kind: StateKind): Promise<unknown> {
    if (kind === "players") return this.execute("getPlayers");
    // legacy has no single structured session/objectives read the pipeline uses.
    return Promise.reject(new Error(`legacy-text does not expose '${kind}'`));
  }

  async readLogLines(seconds = 65): Promise<string[]> {
    const result = await this.execute("getAdminLog", { seconds });
    return Array.isArray(result) ? (result as string[]) : [];
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
          const key = this.lineKey(line);
          if (seen.has(key)) continue;
          seen.add(key);
          onLine(line);
        }
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
