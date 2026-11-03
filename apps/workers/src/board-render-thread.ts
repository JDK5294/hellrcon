/**
 * The board renderer's thread half: receive an input, draw, post the JPEG back.
 *
 * Runs the exact same renderBoardImage the tests exercise — the thread is a place to run it, not a
 * different implementation — and keeps the ground/marble caches for the life of the thread, which
 * is the life of the process. Errors are reported per request rather than thrown, so one bad input
 * cannot take the thread down.
 */
import { parentPort } from "node:worker_threads";
import { renderBoardImage, type BoardImageInput } from "./board-image.js";

parentPort?.on("message", (msg: { id: number; input: BoardImageInput }) => {
  void (async () => {
    try {
      const bytes = await renderBoardImage(msg.input);
      // Transferred, not copied: the JPEG buffer moves between threads without a second allocation.
      const out = new Uint8Array(bytes);
      parentPort?.postMessage({ id: msg.id, bytes: out }, [out.buffer]);
    } catch (err) {
      parentPort?.postMessage({ id: msg.id, error: (err as Error).message });
    }
  })();
});
