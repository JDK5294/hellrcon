/**
 * The relay: buffers formatted lines per channel and flushes them as combined messages on a
 * timer. Batching matters — a busy server's kill feed would blow through Discord's per-channel
 * rate limit if every kill were its own message, so we coalesce a couple of seconds of activity
 * into one post (respecting Discord's 2000-char message cap).
 *
 * Transport is behind {@link MessageSink} so the batching/routing logic is testable with a fake
 * sink and no network.
 */
import type { Logger } from "@app/shared";
import { formatEvent, type Category, type RelayEvent } from "./format.js";

export interface MessageSink {
  send(channelId: string, content: string): Promise<void>;
  /** Optional: post allowing exactly ONE role mention (used when a category configures a ping role).
   *  Sinks without it fall back to send() with the mention as plain text. */
  sendAlert?(channelId: string, text: string, mentionRoleId: string | null): Promise<void>;
}

/** Per-category fine-tuning (panel-configured): ping a role with each batch, and the noise filters. */
export interface CategoryOptions {
  /** role pinged once per posted batch. */
  mentionRoleId?: string | null;
  /** kills: drop regular kills, relay ONLY team kills. */
  teamkillsOnly?: boolean;
  /** admin: also relay each individual ballot, not just the vote's start and result. Off by
   *  default — a kick vote on a full server is one line per player, which buries everything
   *  else in the admin channel. */
  includeVoteBallots?: boolean;
}

/** The routing for one server (or the global default): which categories relay, and to which channel. */
export interface ServerRelay {
  enabled: Set<Category>;
  channels: Record<Category, string | null>;
  /** per-category fine-tuning; absent = no filtering, no pings. */
  options?: Partial<Record<Category, CategoryOptions>>;
}

/** Does the event pass the category's filters? Pure — unit-tested directly. */
export function passesCategoryFilters(category: Category, kind: string, opts?: CategoryOptions): boolean {
  // Ballots default OFF, so this one filters with no options set at all.
  if (kind === "evt.vote.cast" && !opts?.includeVoteBallots) return false;
  if (!opts) return true;
  if (category === "kills" && opts.teamkillsOnly && kind !== "evt.teamkill") return false;
  return true;
}

export interface RelayConfig {
  /** DEFAULT routing — used when a server has no per-server override (or the event has no serverId).
   *  In practice this is the env-configured fallback; per-server config from the DB takes precedence. */
  channels: Record<Category, string | null>;
  /** categories the operator opted into relaying (default). */
  enabled: Set<Category>;
  /** how often to flush buffered lines (ms). */
  flushMs: number;
  /** max characters per Discord message (default 1900, under the 2000 hard cap). */
  maxLen?: number;
  /** optional per-server override provider (DB-backed). Returns null → fall back to the default above. */
  resolve?: (serverId: string | undefined) => ServerRelay | null;
  /** community timezone provider — the clock every relayed line is stamped in. A provider rather
   *  than a string because the value is panel-editable and refreshed on the config timer; absent
   *  = UTC. */
  timezone?: () => string;
}

/** Pack lines into messages no longer than maxLen; an overlong single line is truncated. */
export function chunkLines(lines: string[], maxLen: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let line of lines) {
    if (line.length > maxLen) line = line.slice(0, maxLen - 1) + "…";
    if (cur && cur.length + 1 + line.length > maxLen) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

export class Relay {
  private buffers = new Map<string, string[]>();
  /** channel → role to ping with the next flush (set when a buffered category configures one). */
  private mentions = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sink: MessageSink;
  private readonly config: RelayConfig;
  private readonly log: Logger;

  constructor(sink: MessageSink, config: RelayConfig, log: Logger) {
    this.sink = sink;
    this.config = config;
    this.log = log;
  }

  /** Route + buffer one event. Does not send — the timer (or flush()) does. */
  handle(evt: RelayEvent): void {
    const f = formatEvent(evt, this.config.timezone?.());
    if (!f) return;
    // Per-server routing (DB) takes precedence; fall back to the default (env) routing.
    const per = this.config.resolve?.(evt.serverId) ?? null;
    const enabled = per?.enabled ?? this.config.enabled;
    const channels = per?.channels ?? this.config.channels;
    if (!enabled.has(f.category)) return;
    const channel = channels[f.category];
    if (!channel) return;
    const opts = per?.options?.[f.category];
    if (!passesCategoryFilters(f.category, evt.kind, opts)) return;
    if (opts?.mentionRoleId) this.mentions.set(channel, opts.mentionRoleId);
    const buf = this.buffers.get(channel) ?? [];
    buf.push(f.line);
    this.buffers.set(channel, buf);
  }

  /** The flush in progress, so the timer can never start a second one beside it. Discord sends
   *  are slow on purpose sometimes — a rate-limit retry holds a chunk for seconds — and two
   *  flushes interleaving on one channel post NEWER lines ahead of older ones still in flight.
   *  Chaining keeps exactly one sender and preserves the order events arrived in. */
  private flushing: Promise<void> = Promise.resolve();

  /** Send everything buffered so far, oldest channels first. Clears the buffers up front so a
   *  slow send doesn't drop events that arrive meanwhile; serialized so overlapping timer fires
   *  (or a shutdown drain during a send) cannot reorder a channel's feed. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (this.buffers.size === 0) return;
    const entries = [...this.buffers.entries()];
    const mentions = new Map(this.mentions);
    this.buffers.clear();
    this.mentions.clear();
    const maxLen = this.config.maxLen ?? 1900;
    for (const [channel, lines] of entries) {
      const mention = mentions.get(channel) ?? null;
      let first = true;
      for (const chunk of chunkLines(lines, maxLen)) {
        try {
          // Ping the configured role once per flush (first chunk only), through the sink's
          // mention-allowing path so nothing else in relayed text can ever ping.
          if (first && mention && this.sink.sendAlert) await this.sink.sendAlert(channel, chunk, mention);
          else await this.sink.send(channel, chunk);
        } catch (err) {
          this.log.warn("discord send failed", { channel, err: (err as Error).message });
        }
        first = false;
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.config.flushMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(); // drain on shutdown
  }
}
