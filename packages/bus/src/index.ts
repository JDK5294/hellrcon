/**
 * @app/bus — the event bus that carries `evt.*` events from producers (ingestion) to
 * consumers (plugins, and later a live websocket feed).
 *
 * Two implementations behind one interface:
 *  - {@link InProcessEventBus}: a synchronous in-memory pub/sub. Fine when one process both
 *    ingests and consumes (tests, the API's one-shot `/ingest` endpoint without Redis).
 *  - {@link RedisEventBus}: publishes over Redis pub/sub so events cross process boundaries.
 *    This is what makes the always-on worker's live events reach the API's plugins — the
 *    worker publishes, the API subscribes, and plugins react to real activity.
 *
 * {@link createEventBus} picks the right one: Redis-backed when a URL is configured, else
 * in-process. Consumers only ever see the {@link EventBus} interface.
 */
import { Redis } from "ioredis";
import { createLogger, type Logger } from "@app/shared";

/** A handler for a single event. `kind` is the event's `evt.*` string (or "*" for all). */
export type EventHandler = (event: unknown) => void;

export interface EventBus {
  /** Publish an event under its kind. Fire-and-forget; delivery to remote subscribers is async. */
  emit(kind: string, event: unknown): void;
  /** Subscribe to a kind (or "*" for every event). Returns an unsubscribe function. */
  on(kind: string, handler: EventHandler): () => void;
  /**
   * Keep a value under `key` for `ttlSec` seconds, for this process or another to read back with
   * {@link recall}: the latest of something, never an event, so no handler is sent it.
   * Fire-and-forget like emit.
   */
  remember(key: string, value: unknown, ttlSec: number): void;
  /** What was last remembered under `key`, or null once it has expired, was never kept, or cannot
   *  be read promptly. A caller that gets null finds out for itself. */
  recall(key: string): Promise<unknown>;
  /** Release any underlying connections. Safe to call more than once. */
  close(): Promise<void>;
}

/** The Redis channel every event flows through (kind travels inside the payload). */
export const EVENT_CHANNEL = "app:evt";

/** Where remember() keeps its values, apart from anything else in the same Redis. */
export const SHELF_PREFIX = "app:shelf:";

/** How long recall() waits on Redis. The connection queues commands while Redis is away instead of
 *  failing them, so an unbounded wait would hold a page open until Redis came back. */
const RECALL_TIMEOUT_MS = 250;

/** Wire envelope for a published event. */
interface Envelope {
  kind: string;
  event: unknown;
}

/** Local handler registry shared by both bus implementations. */
class HandlerRegistry {
  private handlers = new Map<string, Set<EventHandler>>();

  add(kind: string, handler: EventHandler): () => void {
    const set = this.handlers.get(kind) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(kind, set);
    return () => set.delete(handler);
  }

  /** Dispatch to handlers for this kind plus any "*" firehose handlers. A throwing handler
   *  never breaks ingestion or sibling handlers. */
  dispatch(kind: string, event: unknown): void {
    for (const h of this.handlers.get(kind) ?? []) this.safe(h, event);
    if (kind !== "*") for (const h of this.handlers.get("*") ?? []) this.safe(h, event);
  }

  private safe(h: EventHandler, event: unknown): void {
    try {
      h(event);
    } catch {
      /* a misbehaving subscriber must not break the producer */
    }
  }
}

/** Synchronous in-memory pub/sub — producer and consumer in the same process. */
export class InProcessEventBus implements EventBus {
  private registry = new HandlerRegistry();
  /** Kept as JSON, as Redis keeps it: a reader gets its own copy, never the writer's object. */
  private shelf = new Map<string, { until: number; json: string }>();

  emit(kind: string, event: unknown): void {
    this.registry.dispatch(kind, event);
  }

  on(kind: string, handler: EventHandler): () => void {
    return this.registry.add(kind, handler);
  }

  remember(key: string, value: unknown, ttlSec: number): void {
    this.shelf.set(key, { until: Date.now() + ttlSec * 1000, json: JSON.stringify(value ?? null) });
  }

  async recall(key: string): Promise<unknown> {
    const kept = this.shelf.get(key);
    if (!kept) return null;
    if (Date.now() >= kept.until) {
      this.shelf.delete(key);
      return null;
    }
    return JSON.parse(kept.json);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

/**
 * Redis-backed pub/sub. Uses two connections because a Redis connection in subscriber mode
 * can't also issue PUBLISH. Local handlers fire only on messages received from Redis (including
 * this process's own publishes), so a single-process setup dispatches exactly once.
 */
export class RedisEventBus implements EventBus {
  private registry = new HandlerRegistry();
  private closed = false;
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly log: Logger;

  constructor(pub: Redis, sub: Redis, log: Logger) {
    this.pub = pub;
    this.sub = sub;
    this.log = log;
    this.sub.on("message", (_channel, message) => this.onMessage(message));
    this.sub.subscribe(EVENT_CHANNEL).catch((err) => this.log.error("bus subscribe failed", { err }));
    this.pub.on("error", (err) => this.log.warn("bus publisher error", { err: err.message }));
    this.sub.on("error", (err) => this.log.warn("bus subscriber error", { err: err.message }));
  }

  emit(kind: string, event: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({ kind, event } satisfies Envelope);
    // Fire-and-forget: a live-event feed must never block or fail ingestion on a Redis hiccup.
    this.pub.publish(EVENT_CHANNEL, payload).catch((err) => this.log.warn("bus publish failed", { err: (err as Error).message, kind }));
  }

  on(kind: string, handler: EventHandler): () => void {
    return this.registry.add(kind, handler);
  }

  remember(key: string, value: unknown, ttlSec: number): void {
    if (this.closed) return;
    this.pub.set(SHELF_PREFIX + key, JSON.stringify(value ?? null), "EX", Math.max(1, Math.ceil(ttlSec)))
      .catch((err) => this.log.warn("bus remember failed", { err: (err as Error).message, key }));
  }

  async recall(key: string): Promise<unknown> {
    if (this.closed) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.pub.get(SHELF_PREFIX + key),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RECALL_TIMEOUT_MS); }),
      ]);
      return typeof raw === "string" ? JSON.parse(raw) : null;
    } catch (err) {
      this.log.warn("bus recall failed", { err: (err as Error).message, key });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private onMessage(message: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(message) as Envelope;
    } catch {
      this.log.warn("bus received unparseable message");
      return;
    }
    if (env && typeof env.kind === "string") this.registry.dispatch(env.kind, env.event);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export interface CreateEventBusOptions {
  /** Redis connection string. Defaults to `REDIS_URL`. When absent, an in-process bus is used. */
  redisUrl?: string;
  /** Component name for the bus's own log lines. */
  component?: string;
}

/**
 * Build the appropriate bus for the environment: Redis-backed when a URL is configured (so
 * events cross process boundaries), else a purely in-process bus. Callers depend only on the
 * {@link EventBus} interface, so switching between them is transparent.
 */
export function createEventBus(opts: CreateEventBusOptions = {}): EventBus {
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  const log = createLogger(opts.component ?? "bus");
  if (!url) {
    log.info("event bus is in-process (no REDIS_URL) — worker events will not reach this process");
    return new InProcessEventBus();
  }
  // lazyConnect keeps construction synchronous; ioredis connects on first use and auto-reconnects.
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
  const sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
  log.info("event bus is Redis-backed", { channel: EVENT_CHANNEL });
  return new RedisEventBus(pub, sub, log);
}
