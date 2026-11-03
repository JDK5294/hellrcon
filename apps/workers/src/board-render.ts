/**
 * The match board render, moved off the event loop.
 *
 * Drawing the board takes seconds of CPU — skia records the scene cheaply and pays for all of it
 * at rasterization, so neither caching nor async encoding gets the cost off the main thread; it was
 * measured freezing the loop for the full render. The workers process is ONE loop shared by every
 * server's ingest, the vote ticks, seeding and broadcast, so a board drawn inline stalls all of it,
 * for every tick, forever.
 *
 * The render is pure data-in/bytes-out, which makes it trivially threadable: one long-lived
 * worker_thread owns the drawing (and its ground/marble caches), the main thread posts the input
 * and awaits the JPEG. Renders are serialized through a promise chain — two servers ticking at
 * once queue rather than fight over the thread's caches.
 *
 * Failure is a downgrade, not an error: if the thread cannot start or dies mid-render (native
 * canvas failed to load, OOM), the caller falls back to rendering inline — a frozen loop once
 * beats no board at all — and the next call tries a fresh thread.
 */
import { Worker } from "node:worker_threads";
import type { BoardImageInput } from "./board-contract.js";

interface Pending { resolve: (b: Buffer) => void; reject: (e: Error) => void }

let thread: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
/** Serializes renders: each call chains behind the last so the thread draws one board at a time. */
let queue: Promise<unknown> = Promise.resolve();

function threadFor(): Worker {
  if (thread) return thread;
  // execArgv is pinned empty: worker threads inherit the parent's, and under `node --test` that
  // flag makes the thread boot as a TEST RUNNER instead of running this entrypoint — it then never
  // answers a message and every render hangs. The thread needs no flags of its own.
  const w = new Worker(new URL("./board-render-thread.js", import.meta.url), { execArgv: [] });
  w.unref(); // the board must never be what keeps the process alive
  w.on("message", (msg: { id: number; bytes?: Uint8Array; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.bytes) p.resolve(Buffer.from(msg.bytes));
    else p.reject(new Error(msg.error ?? "render thread returned nothing"));
  });
  const fail = (why: string) => {
    if (thread === w) thread = null; // next call spawns a fresh one
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error(why));
    }
  };
  w.on("error", (err) => fail(`render thread crashed: ${err.message}`));
  // Any exit — even a clean one — with a render pending must reject it: renders serialize behind
  // the queue, so ONE promise left unsettled here stalls every board forever.
  w.on("exit", (code) => fail(`render thread exited with ${code}`));
  thread = w;
  return w;
}

/**
 * Stop the render thread. The worker app never needs this — its shutdown path force-exits — but
 * the test runner tracks the thread's handle even unref'd and will not let a test process end
 * while it lives.
 */
export async function closeBoardRenderer(): Promise<void> {
  const w = thread;
  thread = null;
  if (w) await w.terminate();
}

/** Draw the board without blocking the event loop. Falls back to drawing inline if the thread is broken. */
export async function renderBoardOffThread(input: BoardImageInput): Promise<Buffer> {
  const run = queue.then(async () => {
    const id = ++seq;
    const w = threadFor();
    return await new Promise<Buffer>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, input });
    });
  }).catch(async (err: Error) => {
    // Inline is a last resort, not a peer: it freezes the loop for the whole render. But the
    // alternative is a channel whose board silently stopped because a native module failed once.
    // Loaded HERE, not at the top of the file: board-image pulls in the native canvas library
    // (~33 MB resident), and a static import would make the main process pay that on every
    // install at startup — for a fallback that only runs when the render thread is broken.
    if (process.env.DEBUG) console.warn(`board render thread failed (${err.message}), rendering inline`);
    const { renderBoardImage } = await import("./board-image.js");
    return await renderBoardImage(input);
  });
  queue = run.catch(() => undefined);
  return run;
}
