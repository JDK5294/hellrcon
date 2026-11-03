/**
 * Per-server runner lifetime.
 *
 * Every background runner in this app is a `while` loop wrapped around one RCON connection, and
 * until now the only thing that ended one was the process exiting. That left two things broken that
 * anyone can do from the panel in ten seconds:
 *
 *   - **Delete a server.** Its six loops kept going: reconnecting on a timer to a host we have been
 *     told to stop talking to, indefinitely, and failing every write against the row that no longer
 *     exists. Handing a server off to someone else did not stop us connecting to it.
 *   - **Fix the connection details.** Correct a wrong RCON password, change the port, or flip a
 *     server from observe to active, and nothing happened — each runner captured the row when it
 *     started, so the old values were used until someone restarted the whole worker. The fix
 *     appeared to do nothing, which is the worst way for a fix to fail.
 *
 * So a runner is now handed a control it can be cancelled through, and the periodic rescan is a
 * supervisor rather than a discovery pass: it starts runners for servers that appeared, cancels
 * them for servers that went away, and restarts them when a field they captured has changed.
 *
 * A restart here is exactly a reconnect — the same thing every loop already does when a connection
 * drops — so it is cheap and safe: durable state (map-vote progress, seeding progress) lives in the
 * database and is re-read on the next tick.
 */
import { background, type Logger } from "@app/shared";

/**
 * The handle a runner watches to know whether it should still be running.
 *
 * One control is shared by all of a server's runners: the unit that starts and stops is the server,
 * not the individual loop.
 */
export interface RunnerControl {
  /** True once these runners should wind down — the server was deleted or reconfigured, or the
   *  process is shutting down. Loops check it where they used to check a process-wide flag. */
  readonly stopped: boolean;
  /** Wind down. Loops exit at their next check, and any sleep in progress returns immediately. */
  cancel(): void;
  /** `sleep`, but it returns as soon as the control is cancelled. Without this a deleted server
   *  would keep its connection open until the end of whatever backoff it happened to be in —
   *  up to a full reconnect interval of talking to a server we are done with. */
  sleep(ms: number): Promise<void>;
}

export function runnerControl(): RunnerControl {
  let alive = true;
  const wake = new Set<() => void>();
  return {
    get stopped() {
      return !alive;
    },
    cancel() {
      alive = false;
      for (const w of [...wake]) w();
    },
    sleep(ms: number): Promise<void> {
      if (!alive) return Promise.resolve();
      return new Promise<void>((resolve) => {
        // Deregisters itself either way, so a runner that sleeps for the life of the process does
        // not accumulate one dead waker per pass.
        const wakeNow = () => {
          clearTimeout(timer);
          wake.delete(wakeNow);
          resolve();
        };
        const timer = setTimeout(wakeNow, ms);
        wake.add(wakeNow);
      });
    },
  };
}

/** One kind of loop, run once per server. `what` names it in logs. */
export interface ServerRunner<S> {
  what: string;
  run: (server: S, ctl: RunnerControl) => Promise<unknown>;
}

/** What one `sync` changed, so the caller can log it (and a test can assert it). */
export interface SyncResult {
  started: string[];
  stopped: string[];
  restarted: string[];
}

export interface Supervisor<S> {
  /** Reconcile the running loops against the current server list. */
  sync(servers: S[]): SyncResult;
  /** Cancel every runner (process shutdown). */
  stopAll(): void;
  /** How many servers currently have runners. */
  readonly size: number;
}

export function createSupervisor<S extends { id: string }>(opts: {
  log: Logger;
  runners: ServerRunner<S>[];
  /** Which fields the runners capture. A change to the returned string restarts that server. */
  fingerprint: (server: S) => string;
}): Supervisor<S> {
  const held = new Map<string, { fingerprint: string; ctl: RunnerControl }>();

  const start = (server: S): void => {
    const entry = { fingerprint: opts.fingerprint(server), ctl: runnerControl() };
    held.set(server.id, entry);
    for (const r of opts.runners) {
      background(opts.log, `${r.what} [${server.id}]`, async () => {
        try {
          await r.run(server, entry.ctl);
        } finally {
          // Returning (or throwing) while the control is still live means the loop fell out of a
          // `while` it was meant to stay inside — it is not coming back on its own, and today that
          // left the server silently half-supervised until the next process restart. Drop the whole
          // entry so the next rescan starts this server's runners again. It takes the server's other
          // loops down with it, deliberately: they share one connection story, and all-or-nothing is
          // easier to reason about than five-of-six.
          if (!entry.ctl.stopped) {
            opts.log.warn("server runner ended on its own — restarting this server on the next rescan", {
              what: r.what,
              serverId: server.id,
            });
            entry.ctl.cancel();
            if (held.get(server.id) === entry) held.delete(server.id);
          }
        }
      });
    }
  };

  return {
    sync(servers) {
      const out: SyncResult = { started: [], stopped: [], restarted: [] };
      const present = new Set<string>();
      for (const server of servers) {
        present.add(server.id);
        const cur = held.get(server.id);
        if (!cur) {
          start(server);
          out.started.push(server.id);
        } else if (opts.fingerprint(server) !== cur.fingerprint) {
          cur.ctl.cancel();
          held.delete(server.id);
          start(server);
          out.restarted.push(server.id);
        }
      }
      for (const [id, cur] of [...held]) {
        if (present.has(id)) continue;
        cur.ctl.cancel();
        held.delete(id);
        out.stopped.push(id);
      }
      return out;
    },
    stopAll() {
      for (const cur of held.values()) cur.ctl.cancel();
      held.clear();
    },
    get size() {
      return held.size;
    },
  };
}

/**
 * The fields a runner reads when it opens its connection, or to decide what it is allowed to do.
 *
 * `engagementMode` is in here because it is the safety guard: an observe server refuses writes, so a
 * loop still holding `observe` after someone switched the server to active keeps quietly declining
 * to act. `name` is in here too — it is only cosmetic (log context and audit summaries), but a
 * restart costs a reconnect and renames are rare, so it is not worth carrying stale names to avoid.
 */
export interface ConnectionFields {
  host: string;
  port: number;
  password: string;
  protocol: string;
  game: string;
  engagementMode: string;
  name: string;
  headerMode?: string | null;
  crconBaseUrl?: string | null;
  /** the per-automation switches — part of the fingerprint so a toggle restarts the runners. */
  automation?: Record<string, boolean | undefined>;
}

/**
 * Switches no runner reads. The app-wide sweeps (VIP and console-admin expiry, the two reconcilers
 * and their "Fix what it finds") read every server's switches afresh on each tick, so flipping
 * one of these must not restart this server's runners: a reconnect, and a map vote or seeding
 * loop starting over, for a switch none of them looks at.
 */
const SWEEP_ONLY_SWITCHES = new Set(["vipSweep", "consoleAdminSweep", "banSync", "vipSync", "banSyncApply", "vipSyncApply"]);

export function connectionFingerprint(s: ConnectionFields): string {
  // Automation is in here deliberately: a runner reads its switch once at start and then holds a
  // connection for hours, so turning a system off must restart the loops for it to mean anything.
  const runnerSwitches = Object.entries(s.automation ?? {}).filter(([k]) => !SWEEP_ONLY_SWITCHES.has(k));
  return [s.host, s.port, s.password, s.protocol, s.game, s.engagementMode, s.name, s.headerMode ?? "", s.crconBaseUrl ?? "", JSON.stringify(runnerSwitches)].join("\u0000");
}
