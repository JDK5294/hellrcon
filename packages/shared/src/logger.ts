/**
 * Structured logging with a component tag and bound context fields, so any log line can be
 * traced to the component, the request, and the entity involved.
 *
 * - `LOG_LEVEL` (debug|info|warn|error, default info) filters output.
 * - `LOG_FORMAT=json` emits one JSON object per line (for log aggregators); otherwise a
 *   readable line for local dev.
 * - `logger.child({ requestId, serverId, ... })` binds context carried on every line.
 * - Passing an `err` field (an Error) records its name/message/stack.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function threshold(): number {
  return LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
}

function serializeErr(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { value: String(err) };
}

function formatPretty(rec: Record<string, unknown>): string {
  const { time, level, component, msg, err, ...rest } = rec;
  const tag = `[${time}] ${String(level).toUpperCase().padEnd(5)} [${component}]`;
  const fields = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  let line = `${tag} ${msg}${fields ? " " + fields : ""}`;
  if (err !== undefined) {
    // serializeErr has already normalized err to {name,message,stack} or {value}. The message must
    // land ON the line: most call sites pass a plain message string (no stack), and dropping it
    // left warnings like "live apply failed" with the actual reason nowhere in the output.
    const e = (err ?? {}) as { name?: string; message?: string; value?: string; stack?: string };
    const detail = e.message ?? e.value ?? String(err);
    line += ` err=${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${detail}`;
    if (e.stack) line += `\n${e.stack}`;
  }
  return line;
}

export function createLogger(component: string, base: LogFields = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVELS[level] < threshold()) return;
    const merged: LogFields = { ...base, ...fields };
    if (merged.err !== undefined) merged.err = serializeErr(merged.err);
    const rec = { time: new Date().toISOString(), level, component, msg, ...merged };
    const line = process.env.LOG_FORMAT === "json" ? JSON.stringify(rec) : formatPretty(rec);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(component, { ...base, ...fields }),
  };
}
