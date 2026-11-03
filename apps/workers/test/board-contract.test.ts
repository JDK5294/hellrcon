import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The main worker process must not load the native canvas library.
 *
 * @napi-rs/canvas costs ~33 MB of resident memory the moment the module graph touches it
 * (measured: 42.8 → 76.0 MB RSS on bare `require`). The drawing happens in a dedicated
 * worker_thread, which pays that once and rightly — but index.ts used to reach board-image.js
 * for one zero-filled constant, and board-render.ts imported the renderer statically for a
 * fallback that only runs when the thread is broken. Every install paid for skia at startup,
 * boards or no boards.
 *
 * This walks the BUILT static import graph from the worker's entrypoint and fails if any path
 * reaches the native module. Static imports only: the fallback's `await import("./board-image.js")`
 * is exactly the legal escape hatch — it loads skia when the fallback actually runs — so a lazy
 * import must not trip the guard.
 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function staticImports(source: string): string[] {
  const out: string[] = [];
  // import ... from "x"; export ... from "x"; import "x" — the three static forms. `import("x")`
  // has no `from` and no bare-import shape, so it does not match.
  for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)) {
    out.push((m[1] ?? m[2])!);
  }
  return out;
}

test("the worker entrypoint's static import graph never reaches the native canvas library", () => {
  const seen = new Set<string>();
  const queue = ["index.js"];
  const offenders: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(DIST, file), "utf8");
    for (const spec of staticImports(src)) {
      if (spec === "@napi-rs/canvas") offenders.push(`${file} statically imports ${spec}`);
      // Only follow this package's own modules; workspace deps have no canvas (the panel is a
      // browser app and everything else is data code), and following them would drag node_modules in.
      if (spec.startsWith("./")) queue.push(join(dirname(file), spec).replaceAll("\\", "/"));
    }
  }
  assert.ok(seen.size > 10, `walked only ${seen.size} modules — the entrypoint moved and the walk is not seeing the graph`);
  assert.ok(seen.has("board-contract.js"), "index.js no longer reaches the board contract — retarget this walk");
  assert.deepEqual(offenders, [], `the main process would load skia (~33 MB) at startup:\n${offenders.join("\n")}`);
  // The render thread is where skia belongs — make sure the split did not orphan it.
  const thread = readFileSync(join(DIST, "board-render-thread.js"), "utf8");
  assert.ok(staticImports(thread).includes("./board-image.js"), "the render thread no longer loads the renderer");
});
