import { test } from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus, RedisEventBus, EVENT_CHANNEL, SHELF_PREFIX } from "../src/index.ts";
import { createLogger } from "@app/shared";

const log = createLogger("test");

test("InProcessEventBus dispatches to matching kind handlers", () => {
  const bus = new InProcessEventBus();
  const seen: unknown[] = [];
  bus.on("evt.kill", (e) => seen.push(e));
  bus.emit("evt.kill", { a: 1 });
  bus.emit("evt.chat.team", { b: 2 }); // different kind — ignored
  assert.deepEqual(seen, [{ a: 1 }]);
});

test("wildcard '*' handler receives every event exactly once", () => {
  const bus = new InProcessEventBus();
  const all: string[] = [];
  bus.on("*", (e) => all.push((e as { kind: string }).kind));
  bus.emit("evt.kill", { kind: "evt.kill" });
  bus.emit("evt.chat.team", { kind: "evt.chat.team" });
  assert.deepEqual(all, ["evt.kill", "evt.chat.team"]);
});

test("a specific + wildcard handler both fire for the same event, once each", () => {
  const bus = new InProcessEventBus();
  let specific = 0;
  let wild = 0;
  bus.on("evt.kill", () => specific++);
  bus.on("*", () => wild++);
  bus.emit("evt.kill", {});
  assert.equal(specific, 1);
  assert.equal(wild, 1);
});

test("unsubscribe stops further delivery", () => {
  const bus = new InProcessEventBus();
  let count = 0;
  const off = bus.on("evt.kill", () => count++);
  bus.emit("evt.kill", {});
  off();
  bus.emit("evt.kill", {});
  assert.equal(count, 1);
});

test("a throwing handler does not break sibling handlers", () => {
  const bus = new InProcessEventBus();
  let reached = false;
  bus.on("evt.kill", () => {
    throw new Error("boom");
  });
  bus.on("evt.kill", () => {
    reached = true;
  });
  bus.emit("evt.kill", {});
  assert.equal(reached, true);
});

// A minimal in-memory stand-in for Redis pub/sub so we can prove that an event emitted on one
// RedisEventBus (the worker) is delivered to a handler on another (the API) — the whole point of
// the cross-process bus — without needing a live Redis.
class FakeBroker {
  private subscribers = new Map<string, Set<(channel: string, message: string) => void>>();
  publish(channel: string, message: string): void {
    for (const cb of this.subscribers.get(channel) ?? []) cb(channel, message);
  }
  subscribe(channel: string, cb: (channel: string, message: string) => void): void {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(cb);
    this.subscribers.set(channel, set);
  }
}

function fakeRedis(broker: FakeBroker) {
  let messageCb: ((channel: string, message: string) => void) | null = null;
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "message") messageCb = cb as typeof messageCb;
      return this;
    },
    async subscribe(channel: string) {
      broker.subscribe(channel, (ch, msg) => messageCb?.(ch, msg));
      return 1;
    },
    async publish(channel: string, message: string) {
      broker.publish(channel, message);
      return 1;
    },
    async quit() {
      return "OK";
    },
  };
}

test("RedisEventBus delivers a published event across two bus instances", async () => {
  const broker = new FakeBroker();
   
  const worker = new RedisEventBus(fakeRedis(broker) as any, fakeRedis(broker) as any, log);
   
  const api = new RedisEventBus(fakeRedis(broker) as any, fakeRedis(broker) as any, log);

  const received: unknown[] = [];
  api.on("evt.kill", (e) => received.push(e));

  worker.emit("evt.kill", { playerName: "Peter" });
  // publish → broker → api's subscriber "message" → dispatch, all synchronous in the fake.
  await Promise.resolve();
  assert.deepEqual(received, [{ playerName: "Peter" }]);

  await worker.close();
  await api.close();
});

test("RedisEventBus publishes on the shared EVENT_CHANNEL", async () => {
  const broker = new FakeBroker();
  let seenChannel: string | null = null;
  broker.subscribe(EVENT_CHANNEL, (ch) => (seenChannel = ch));
   
  const bus = new RedisEventBus(fakeRedis(broker) as any, fakeRedis(broker) as any, log);
  bus.emit("evt.kill", {});
  assert.equal(seenChannel, EVENT_CHANNEL);
  await bus.close();
});

// remember/recall: the latest of something, kept for another process to read (the worker's reads of
// a server's live state, read back by the API's Live page). Never an event: no handler sees it.

test("InProcessEventBus: a remembered value is recalled as its own copy, and is gone once it expires", async () => {
  const bus = new InProcessEventBus();
  const heard: unknown[] = [];
  bus.on("*", (e) => heard.push(e));
  const roster = [{ name: "A" }];
  // Half a second to live: long enough that a loaded machine reads it back before it lapses.
  bus.remember("live:s1:players", { at: 1, value: roster }, 0.5);
  roster.push({ name: "B" });
  const first = (await bus.recall("live:s1:players")) as { value: { name: string }[] };
  assert.deepEqual(first, { at: 1, value: [{ name: "A" }] }, "what was kept, not the writer's object as it changed after");
  first.value.length = 0;
  assert.deepEqual(await bus.recall("live:s1:players"), { at: 1, value: [{ name: "A" }] }, "a reader's changes are its own");
  assert.equal(await bus.recall("live:s2:players"), null, "never kept");
  assert.deepEqual(heard, [], "no handler is sent a remembered value");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await bus.recall("live:s1:players"), null, "expired");
});

/** A fake Redis that keeps SET values (and their arguments) for GET, shared by every bus on it. */
function shelfRedis(store: Map<string, string>, sets: unknown[][], get?: (key: string) => Promise<string | null>) {
  return {
    ...fakeRedis(new FakeBroker()),
    async set(...args: unknown[]) {
      sets.push(args);
      store.set(String(args[0]), String(args[1]));
      return "OK";
    },
    get: get ?? (async (key: string) => store.get(key) ?? null),
  };
}

test("RedisEventBus: one process remembers, another recalls, and nothing crosses as an event", async () => {
  const store = new Map<string, string>();
  const sets: unknown[][] = [];
  const worker = new RedisEventBus(shelfRedis(store, sets) as any, shelfRedis(store, sets) as any, log);
  const api = new RedisEventBus(shelfRedis(store, sets) as any, shelfRedis(store, sets) as any, log);
  const heard: unknown[] = [];
  api.on("*", (e) => heard.push(e));

  worker.remember("live:s1:session", { at: 5, value: { map: "foy" } }, 120);
  await Promise.resolve();
  assert.deepEqual(sets, [[`${SHELF_PREFIX}live:s1:session`, JSON.stringify({ at: 5, value: { map: "foy" } }), "EX", 120]],
    "kept under its own prefix, with Redis doing the expiry");
  assert.deepEqual(await api.recall("live:s1:session"), { at: 5, value: { map: "foy" } });
  assert.equal(await api.recall("live:s9:session"), null);
  assert.deepEqual(heard, []);

  await worker.close();
  await api.close();
  worker.remember("live:s1:session", { at: 6, value: {} }, 120);
  assert.equal(sets.length, 1, "a closed bus keeps nothing");
  assert.equal(await api.recall("live:s1:session"), null, "and reads nothing");
});

test("RedisEventBus: a recall Redis cannot answer promptly comes back null instead of waiting", async () => {
  const store = new Map<string, string>([[`${SHELF_PREFIX}k`, JSON.stringify({ at: 1, value: 1 })]]);
  // While Redis is away, the client queues commands rather than failing them: the reply comes
  // whenever Redis does.
  const slowGet = (key: string) => new Promise<string | null>((r) => setTimeout(() => r(store.get(key) ?? null), 1500));
  const bus = new RedisEventBus(shelfRedis(store, [], slowGet) as any, shelfRedis(store, []) as any, log);
  const started = Date.now();
  assert.equal(await bus.recall("k"), null);
  assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms`);

  const failing = new RedisEventBus(shelfRedis(store, [], async () => { throw new Error("down"); }) as any, shelfRedis(store, []) as any, log);
  assert.equal(await failing.recall("k"), null, "a failed read is no answer either");
  store.set(`${SHELF_PREFIX}bad`, "{not json");
  assert.equal(await new RedisEventBus(shelfRedis(store, []) as any, shelfRedis(store, []) as any, log).recall("bad"), null);
  await bus.close();
  await failing.close();
});
