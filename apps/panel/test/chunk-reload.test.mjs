// Screens load on demand, so a panel updated under an open tab leaves it asking for screen files
// that are gone. lib/chunkReload decides what the screen area does: recognise that failure, and
// reload the page for it at most once a minute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isChunkLoadError, mayReload, RELOADED_KEY, RELOAD_WINDOW_MS } from "../lib/chunkReload.ts";

test("a screen file that could not be fetched is recognised; other errors are not", () => {
  const webpack = new Error("Loading chunk 6049 failed.\n(error: http://panel/_next/static/chunks/6049.js)");
  webpack.name = "ChunkLoadError";
  assert.equal(isChunkLoadError(webpack), true);
  assert.equal(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://panel/a.js")), true, "Chrome");
  assert.equal(isChunkLoadError(new TypeError("error loading dynamically imported module: http://panel/a.js")), true, "Firefox");
  assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true, "Safari");
  assert.equal(isChunkLoadError(new Error("Loading CSS chunk 12 failed.")), true);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false, "a screen's own crash");
  assert.equal(isChunkLoadError("Loading chunk 1 failed"), false, "only real errors count");
  assert.equal(isChunkLoadError(null), false);
});

test("one automatic reload a minute for a missing screen file; a second failure stays on screen", () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  assert.equal(mayReload(store, 1_000_000), true, "the first failure reloads");
  assert.equal(mem.get(RELOADED_KEY), "1000000");
  assert.equal(mayReload(store, 1_005_000), false, "again inside the minute: no reload loop");
  assert.equal(mayReload(store, 1_000_000 + RELOAD_WINDOW_MS + 1), true, "after the minute it may reload again");
  assert.equal(mayReload(null), false, "no storage: no automatic reload");
  assert.equal(mayReload({ getItem() { throw new Error("blocked"); }, setItem() {} }), false, "storage that throws: no automatic reload");
});
