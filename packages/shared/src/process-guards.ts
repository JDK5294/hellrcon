/**
 * Last-resort handlers for the two faults that kill a Node process from outside any try/catch:
 * a rejected promise nobody awaited, and a throw on a callback stack.
 *
 * The policy is deliberately crash-and-restart, not swallow-and-continue. After an uncaught
 * throw the process state is unknown — a half-written batch, a connection mid-handshake, a lock
 * still held — and carrying on from there corrupts data far more quietly than exiting does. Our
 * containers are supervised, so exiting is recovery.
 *
 * What these handlers add is the part crashing does badly on its own: a line in the SAME
 * structured stream as every other log, with the component that died and the reason. Node's own
 * behaviour prints a raw stack to stderr, which an aggregator collecting JSON either drops or
 * files under nothing — so operators saw a container restart with no explanation of why.
 *
 * `beforeExit` runs first so an app can stop the bleeding (flush the bus, mark its heartbeat
 * stopped). It is best-effort and time-boxed: a hung cleanup must not turn a crash into a hang,
 * which is strictly worse — a hung container keeps its lock and its port and never restarts.
 */
import type { Logger } from "./logger.js";

/** How long a `beforeExit` hook gets before we exit anyway. */
const CLEANUP_BUDGET_MS = 2_000;
/** Grace for the log line to reach stdout before the process goes away. */
const FLUSH_MS = 50;

export interface CrashGuardOptions {
  /** Best-effort cleanup, time-boxed. Never let it throw the process into a second crash. */
  beforeExit?: () => void | Promise<void>;
  /** Exit code. Non-zero so a supervisor treats it as a failure and restarts. */
  exitCode?: number;
}

/**
 * Install `unhandledRejection` and `uncaughtException` handlers that log through `log` and then
 * exit. Idempotent per process: a second call replaces nothing and adds nothing, so an app that
 * imports two components which both call it still gets exactly one handler.
 *
 * Note that adding an `unhandledRejection` listener suppresses Node's default crash, so this
 * handler is now the only thing that ends the process — it must always exit, on every path.
 */
export function installCrashHandlers(log: Logger, opts: CrashGuardOptions = {}): void {
  const g = globalThis as { __crashHandlersInstalled?: boolean };
  if (g.__crashHandlersInstalled) return;
  g.__crashHandlersInstalled = true;

  const exitCode = opts.exitCode ?? 1;
  let dying = false;

  const die = (kind: string, err: unknown, extra: Record<string, unknown> = {}): void => {
    // A crash inside the crash handler must not recurse. First one wins; the rest are noise.
    if (dying) return;
    dying = true;
    log.error(`fatal: ${kind}`, { err, ...extra });

    const finish = (): void => {
      // console.* can be asynchronous when stdout is a pipe (which it is under a container
      // runtime), so exiting on the same tick can lose the very line explaining the crash.
      setTimeout(() => process.exit(exitCode), FLUSH_MS);
    };

    if (!opts.beforeExit) return finish();
    let settled = false;
    const once = (): void => {
      if (settled) return;
      settled = true;
      finish();
    };
    const budget = setTimeout(() => {
      if (!settled) log.error("fatal: cleanup did not finish in time — exiting anyway", { budgetMs: CLEANUP_BUDGET_MS });
      once();
    }, CLEANUP_BUDGET_MS);
    budget.unref?.();
    void (async () => {
      try {
        await opts.beforeExit?.();
      } catch (cleanupErr) {
        log.error("fatal: cleanup failed", { err: cleanupErr });
      } finally {
        clearTimeout(budget);
        once();
      }
    })();
  };

  process.on("uncaughtException", (err) => die("uncaught exception", err));
  process.on("unhandledRejection", (reason) => {
    // `reason` is whatever was rejected — very often not an Error, so the logger's error
    // serializer would print nothing useful. Wrap non-Errors so there is at least a value.
    die("unhandled promise rejection", reason instanceof Error ? reason : new Error(`non-Error rejection: ${String(reason)}`));
  });
}

/** Test seam: forget that handlers were installed. Not for production use. */
export function resetCrashHandlersForTest(): void {
  const g = globalThis as { __crashHandlersInstalled?: boolean };
  g.__crashHandlersInstalled = false;
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
}
