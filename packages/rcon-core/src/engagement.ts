/**
 * Engagement-mode guard — the safety mechanism that lets us run alongside an existing
 * CRCON without touching it. In `observe` mode every write is refused *before* it hits
 * the wire; only `active` servers can issue state-changing commands.
 */
import type { EngagementMode } from "@app/shared";
import type { RconAdapter, ServerConn, StateKind, StreamOptions, Unsubscribe } from "./types.js";

export class ObserveModeViolation extends Error {
  constructor(command: string) {
    super(`Refused write command '${command}': server is in observe mode (read-only). Switch it to 'active' to allow writes.`);
    this.name = "ObserveModeViolation";
  }
}

/**
 * Wrap an adapter so its behavior respects the server's engagement mode.
 * `active` passes through; `observe` blocks every write command.
 */
export function guardEngagement(adapter: RconAdapter, mode: EngagementMode): RconAdapter {
  if (mode === "active") return adapter;
  return new ObserveGuard(adapter);
}

class ObserveGuard implements RconAdapter {
  constructor(private readonly inner: RconAdapter) {}
  get protocol() {
    return this.inner.protocol;
  }
  get canWrite() {
    return false;
  }
  get commands() {
    return this.inner.commands;
  }
  connect(conn: ServerConn): Promise<void> {
    return this.inner.connect(conn);
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  execute(command: string, params?: Record<string, unknown>): Promise<unknown> {
    // Classify against the adapter's own (game-supplied) command table. Unknown commands are
    // treated as writes — refuse rather than let an unclassifiable command through in observe.
    const access = this.inner.commands[command]?.access;
    if (access !== "read") throw new ObserveModeViolation(command);
    return this.inner.execute(command, params);
  }
  readState(kind: StateKind): Promise<unknown> {
    return this.inner.readState(kind);
  }
  readLogLines(seconds?: number): Promise<string[]> {
    return this.inner.readLogLines(seconds);
  }
  streamLogs(onLine: (raw: string) => void, opts?: StreamOptions): Unsubscribe {
    return this.inner.streamLogs(onLine, opts);
  }
  raw(): Promise<never> {
    // An arbitrary command can't be classified read/write, so observe refuses it outright.
    throw new ObserveModeViolation("raw console");
  }
}
