// What a browser downloads to open the panel. Every screen loads on demand (lib/onDemand), so
// opening the panel fetches the shell and the screen it is on, not every screen there is. These
// budgets fail when a screen is pulled back into the startup download — a static import of a
// screen from app/page.tsx, or a hub importing its tabs eagerly. Before screens loaded on demand,
// the startup scripts came to about 1.6 MB, nearly all of it one file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const SKIP = existsSync(join(OUT, "index.html")) ? false : "panel not built (out/ missing)";
const KiB = 1024;

/** The scripts index.html makes a modern browser fetch at startup (noModule ones it skips). */
function startupScripts() {
  const html = readFileSync(join(OUT, "index.html"), "utf8");
  return [...html.matchAll(/<script\b([^>]*)>/g)]
    .map((m) => m[1])
    .filter((attrs) => !/\bnomodule\b/i.test(attrs))
    .map((attrs) => /\bsrc="([^"]+)"/.exec(attrs)?.[1])
    .filter(Boolean)
    .map((src) => ({ src, bytes: statSync(join(OUT, src)).size }));
}

test("opening the panel downloads the shell, not every screen", { skip: SKIP }, () => {
  const scripts = startupScripts();
  assert.ok(scripts.length > 0, "index.html lists its startup scripts");
  const total = scripts.reduce((n, s) => n + s.bytes, 0);
  assert.ok(total <= 700 * KiB, `startup scripts are ${Math.round(total / KiB)} KiB (budget 700): ${scripts.map((s) => `${s.src} ${Math.round(s.bytes / KiB)}`).join(", ")}`);
  const page = scripts.find((s) => s.src.includes("/app/page-"));
  assert.ok(page, "the app's own entry script is among them");
  assert.ok(page.bytes <= 250 * KiB, `the app's entry script is ${Math.round(page.bytes / KiB)} KiB (budget 250) — a screen is being bundled into it`);
});

/*
 * Screens load on demand through lib/onDemand, never through React's Suspense (next/dynamic,
 * React.lazy): Suspense holds its placeholder 300ms at least once shown, so every screen's first
 * opening waited that long however fast its code came, and asked for its data only after.
 */
test("code loaded on demand goes through lib/onDemand, not React's Suspense", () => {
  const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|mjs)$/.test(name) && /from "next\/dynamic"|\blazy\(\s*\(\)\s*=>\s*import\(|<Suspense\b/.test(readFileSync(path, "utf8"))) offenders.push(path.slice(PANEL.length + 1));
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(join(PANEL, dir));
  assert.deepEqual(offenders, []);
});
