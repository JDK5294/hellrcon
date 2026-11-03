/**
 * Send one message to EVERY player on a server.
 *
 * The game gives no command for this. There are exactly two server-wide message surfaces —
 * `broadcast` (the scrolling line across the top left) and `setWelcomeMessage` (shown on join) —
 * and neither is the one staff usually mean. The message that sits in the top right until the
 * player acknowledges it is `messagePlayer`, and `messagePlayer` addresses ONE player: reaching a
 * full server means reading the roster and sending it once per person.
 *
 * That is a fan-out, so it lives here rather than being written twice. Two callers need it and
 * they must behave identically: the map-vote reminder in the worker, and the Messages screen's
 * send-to-everyone in the API. A reminder nobody sees and a reminder that hammers the server are
 * the same bug from opposite directions.
 *
 * Three properties this guarantees, all learned from the paths above:
 *
 *  - **Paced.** A hundred sends fired at once is a hundred round trips down a small connection
 *    pool, at the exact moment (match start) the server is busiest. `delayMs` spaces them.
 *  - **Best effort per player.** One player disconnecting mid-fan-out fails one send; it must not
 *    abandon the other ninety-nine. Those failures are counted and returned rather than thrown.
 *    A refusal that is not about one player — an observe-mode server rejecting writes outright —
 *    is the exception, and throws, because counting it as ninety-nine dropped messages describes
 *    the wrong problem.
 *  - **Bounded.** `maxRecipients` refuses a roster that reads absurdly large rather than emitting
 *    an unbounded burst — the same instinct as the payout ceiling.
 */
import { ObserveModeViolation } from "./engagement.js";

/** The narrow slice of the server client this needs — so tests can hand it a fake. */
export interface MessageAllClient {
  readState(kind: string): Promise<unknown>;
  execute(command: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface MessageAllOptions {
  /** Milliseconds between sends. 0 is legal (tests); production should pace. */
  delayMs?: number;
  /** Refuse rather than fan out past this many players. */
  maxRecipients?: number;
  /** Called once per failed send, for logging. Never rethrown. */
  onError?: (playerId: string, err: Error) => void;
}

export interface MessageAllResult {
  /** How many players the roster held. */
  found: number;
  /** How many sends the server accepted. */
  sent: number;
  /** How many sends failed (a player who left mid-fan-out, a refused command). */
  failed: number;
}

const DEFAULT_DELAY_MS = 40;
/** The spacing every fan-out of player messages uses — exported so the API's bulk sends pace the
 *  same way instead of firing a burst the game can lose. */
export const MESSAGE_PACE_MS = DEFAULT_DELAY_MS;
/** A Hell Let Loose server seats 100. Anything far past that is a bad roster read, not a full
 *  server — refuse instead of emitting thousands of sends. */
const DEFAULT_MAX = 200;

/**
 * Read the roster the same way every other caller does. The state reader returns either a bare
 * array or `{ players: [...] }` depending on protocol, and a player's id is `iD` on the binary
 * protocol and `id` on the legacy one — this is the union of both, matching the seeding and
 * auto-mod loops.
 */
export function rosterPlayerIds(raw: unknown): string[] {
  return rosterPlayers(raw).map((p) => p.playerId);
}

/** The roster as {id, name} — the name lets a per-player message greet each recipient by it. */
export function rosterPlayers(raw: unknown): { playerId: string; playerName: string | null }[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { players?: unknown[] } | null)?.players)
      ? (raw as { players: unknown[] }).players
      : [];
  const out: { playerId: string; playerName: string | null }[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    // First NON-EMPTY spelling: an empty `iD` must not shadow a real `id` (see rosterIdOf).
    let id = "";
    for (const k of ["iD", "id", "Id", "ID"]) { const v = String(entry?.[k] ?? "").trim(); if (v) { id = v; break; } }
    if (id) out.push({ playerId: id, playerName: entry?.name != null ? String(entry.name) : null });
  }
  return out;
}

export async function messageEveryone(
  client: MessageAllClient,
  /** The text, or a function giving each recipient their own (placeholders filled per player). */
  message: string | ((player: { playerId: string; playerName: string | null }) => string | Promise<string>),
  opts: MessageAllOptions = {},
): Promise<MessageAllResult> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const max = opts.maxRecipients ?? DEFAULT_MAX;

  const players = rosterPlayers(await client.readState("players"));
  const ids = players.map((p) => p.playerId);
  if (ids.length > max) {
    throw new Error(`the roster read back ${ids.length} players, past the ${max} ceiling — refusing to fan out`);
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const playerId = ids[i]!;
    try {
      const text = typeof message === "string" ? message : await message(players[i]!);
      await client.execute("messagePlayer", { playerId, message: text });
      sent++;
    } catch (err) {
      /**
       * A refusal to write AT ALL is not a per-player failure, and must not be counted as ninety-nine
       * of them. On an observe-mode server every send throws this, so swallowing it turned "this
       * server is read-only" into a successful-looking `sent: 0, failed: 100` — reported to staff as
       * players who "most likely left". Rethrow on the first one: the ninety-nine retries would fail
       * identically, and the caller needs to hear the real reason.
       */
      if (err instanceof ObserveModeViolation) throw err;
      // Anything else is per-player: one person leaving mid-send must not cost everyone else theirs.
      failed++;
      opts.onError?.(playerId, err as Error);
    }
    // Pace between sends, but never after the last one — that is dead time on every call.
    if (delayMs > 0 && i < ids.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { found: ids.length, sent, failed };
}
