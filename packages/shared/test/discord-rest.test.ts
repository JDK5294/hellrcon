import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordRest, type DiscordLane } from "../src/discord-rest.ts";

/**
 * A virtual clock: sleeps advance time instantly, so a test about a 30-second stand-down runs in
 * microseconds and asserts on the ORDER things happened in rather than on wall time.
 */
function harness(script: (call: { path: string; n: number }) => { status?: number; headers?: Record<string, string>; body?: unknown }) {
  let clock = 0;
  const calls: { path: string; atMs: number; lane?: string }[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    calls.push({ path, atMs: clock });
    const r = script({ path, n });
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  const rest = createDiscordRest({
    token: "t",
    fetchImpl,
    now: () => clock,
    // Sleeping jumps the clock and yields, so queued work can interleave the way it would live.
    sleep: async (ms: number) => { clock += Math.max(0, ms); await Promise.resolve(); },
  });
  return { rest, calls, clockAt: () => clock };
}

const ok = () => ({ status: 200, headers: { "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "5", "x-ratelimit-reset-after": "1" } });

test("calls in one bucket serialise; the response's own bucket hash becomes the key", async () => {
  const h = harness(() => ok());
  await Promise.all([
    h.rest.request({ routeKey: "GET /guilds/1/members", path: "/guilds/1/members/1" }),
    h.rest.request({ routeKey: "GET /guilds/1/members", path: "/guilds/1/members/2" }),
    h.rest.request({ routeKey: "GET /guilds/1/members", path: "/guilds/1/members/3" }),
  ]);
  assert.deepEqual(h.calls.map((c) => c.path), ["/guilds/1/members/1", "/guilds/1/members/2", "/guilds/1/members/3"]);
});

test("an exhausted bucket waits out its window BEFORE spending the next request", async () => {
  // remaining:0 with a 2s reset — the second call must not be fired until the clock has moved.
  const h = harness(() => ({ status: 200, headers: { "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" } }));
  await h.rest.request({ routeKey: "R", path: "/a" });
  await h.rest.request({ routeKey: "R", path: "/b" });
  assert.equal(h.calls[0]!.atMs, 0);
  assert.ok(h.calls[1]!.atMs >= 2000, `second call waited out the window (fired at ${h.calls[1]!.atMs}ms)`);
});

/*
 * The reason the whole client exists: a person pressing a button must not queue behind a sweep.
 */
test("interactive work jumps ahead of background work already queued", async () => {
  const h = harness(() => ok());
  const seen: string[] = [];
  const bg = (p: string) => h.rest.request({ routeKey: "R", path: p, lane: "background" as DiscordLane }).then(() => seen.push(p));
  const fg = (p: string) => h.rest.request({ routeKey: "R", path: p, lane: "interactive" as DiscordLane }).then(() => seen.push(p));
  // Five background calls are queued first; one interactive arrives while they wait.
  const all = [bg("/bg1"), bg("/bg2"), bg("/bg3"), bg("/bg4"), bg("/bg5")];
  all.push(fg("/human"));
  await Promise.all(all);
  // The first call was already in flight, but the human beat every background call still queued.
  const humanAt = seen.indexOf("/human");
  assert.ok(humanAt <= 1, `the human was served second at the latest, got position ${humanAt + 1}: ${seen.join(" ")}`);
});

test("a 429 stands background work down, and the retry honours the body's retry_after", async () => {
  const h = harness(({ path, n }) => (path === "/limited" && n === 1
    ? { status: 429, headers: { "x-ratelimit-bucket": "b1", "x-ratelimit-scope": "user" }, body: { retry_after: 1.5 } }
    : ok()));
  const res = await h.rest.request({ routeKey: "R", path: "/limited" });
  assert.equal(res.status, 200, "the retry succeeded");
  assert.equal(h.calls.length, 2, "one refusal, one retry");
  assert.ok(h.calls[1]!.atMs >= 1500, `waited the 1.5s it was told (retried at ${h.calls[1]!.atMs}ms)`);
  const stats = h.rest.stats();
  assert.equal(stats.rateLimitHits, 1);
  assert.ok(stats.backgroundHeldUntilMs > 0, "background is standing down after the 429");
});

test("a GLOBAL 429 pauses every bucket, not only the one that earned it", async () => {
  const h = harness(({ path, n }) => (path === "/first" && n === 1
    ? { status: 429, headers: { "x-ratelimit-global": "true" }, body: { retry_after: 3 } }
    : ok()));
  await h.rest.request({ routeKey: "A", path: "/first" });
  // A DIFFERENT bucket: without a shared global pause this would fire immediately at 0ms.
  await h.rest.request({ routeKey: "B", path: "/other" });
  const other = h.calls.find((c) => c.path === "/other")!;
  assert.ok(other.atMs >= 3000, `the unrelated bucket waited out the global pause (fired at ${other.atMs}ms)`);
  assert.equal(h.rest.stats().globalPauses, 1);
});

test("a bucket that keeps refusing hands the 429 back instead of retrying forever", async () => {
  const h = harness(() => ({ status: 429, headers: { "x-ratelimit-scope": "user" }, body: { retry_after: 0.1 } }));
  const res = await h.rest.request({ routeKey: "R", path: "/always" });
  assert.equal(res.status, 429, "the caller gets the refusal to deal with");
  assert.ok(h.calls.length <= 5, `bounded retries, got ${h.calls.length}`);
});

test("different buckets do not block each other", async () => {
  const h = harness(({ path }) => ({
    status: 200,
    headers: { "x-ratelimit-bucket": path.startsWith("/g") ? "guilds" : "channels", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5" },
  }));
  await Promise.all([
    h.rest.request({ routeKey: "GUILDS", path: "/g1" }),
    h.rest.request({ routeKey: "CHANNELS", path: "/c1" }),
  ]);
  // Both fired at once: exhausting the guild bucket must not delay a channel post.
  assert.deepEqual(h.calls.map((c) => c.atMs), [0, 0]);
});

/**
 * A hung connection must end, and must not take the bucket with it.
 *
 * This client drains a bucket one request at a time, so an un-deadlined `fetch` is not one lost
 * call: the drain loop stays inside it, everything queued behind it waits, and none of those
 * callers' promises ever settle. A background sweep against a stalled socket would take the
 * interactive lane down with it — which is the exact failure the priority lanes exist to prevent.
 *
 * `request()` takes no signal, so a caller cannot fix this from outside; the deadline has to be
 * the client's own. Here the timeout is forced to 0 and the first call never resolves on its own.
 */
test("a request that hangs times out, and the call queued behind it still runs", async () => {
  let released: (() => void) | null = null;
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    calls.push(path);
    if (path === "/hang") {
      // A socket that never answers: it settles only when this client's own signal aborts it.
      // The keep-alive timer is load-bearing — `AbortSignal.timeout` is unref'd, so with nothing
      // else pending the process would settle before the abort ever fired and this would be a
      // test about Node's exit behaviour rather than about the client.
      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("the client never gave up")), 5_000);
        const signal = init?.signal;
        const fail = () => {
          clearTimeout(keepAlive);
          reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail);
        released = fail;
      });
    }
    return new Response("{}", { status: 200, headers: { "x-ratelimit-bucket": "b1" } });
  }) as unknown as typeof fetch;

  const rest = createDiscordRest({ token: "t", fetchImpl, requestTimeoutMs: 25 });
  // Same routeKey, so the second genuinely queues behind the first rather than getting its own
  // bucket — the point is that a wedged bucket drains again.
  const hung = rest.request({ routeKey: "SAME", path: "/hang" });
  const behind = rest.request({ routeKey: "SAME", path: "/after" });

  await assert.rejects(hung, /abort/i, "the hung call ends instead of waiting on the network forever");
  const res = await behind;
  assert.equal(res.status, 200, "and the request behind it is still served");
  assert.deepEqual(calls, ["/hang", "/after"]);
  assert.equal(typeof released, "function"); // the stub really did hold the socket open
});
