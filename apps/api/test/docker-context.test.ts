import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadApiConfig } from "../dist/config.js";

// The Dockerfile copies every workspace manifest BEFORE `pnpm install` so that a source-only edit
// reuses the installed node_modules layer instead of reinstalling the workspace from scratch. That
// speed win comes with a trap: the list is written out by hand, and a manifest missing from it does
// not fail the install — pnpm simply never creates that package's node_modules, and the build dies
// much later with "cannot find module @app/...". It happened on the first version of this file,
// which was generated from apps/* and packages/* and silently dropped the plugins/* glob.
//
// So the source of truth is pnpm-workspace.yaml, and this test holds the Dockerfile to it. Adding a
// package to the workspace now fails here rather than in someone's `docker compose up`.
const repoRoot = (() => {
  let d = dirname(new URL(import.meta.url).pathname);
  while (!existsSync(join(d, "pnpm-workspace.yaml"))) d = dirname(d);
  return d;
})();

function workspaceManifests(): string[] {
  const yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1]!.trim().replace(/^["']|["']$/g, ""));
  return globs
    .flatMap((g) => globSync(`${g.replace(/\/$/, "")}/package.json`, { cwd: repoRoot }))
    .map((p) => p.split(/[\\/]/).join("/"))
    .sort();
}

test("the Dockerfile copies every workspace manifest, and copies them before pnpm install", () => {
  const dockerfile = readFileSync(join(repoRoot, "apps/api/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY\s+(\S+\/package\.json)\s/gm)].map((m) => m[1]!).sort();
  const expected = workspaceManifests();

  assert.deepEqual(copied, expected,
    `apps/api/Dockerfile must COPY exactly the manifests pnpm-workspace.yaml resolves to.\n` +
    `  missing: ${expected.filter((p) => !copied.includes(p)).join(", ") || "none"}\n` +
    `  stale:   ${copied.filter((p) => !expected.includes(p)).join(", ") || "none"}`);

  // The ordering IS the optimisation — manifests above the install, source below it. Compared by
  // LINE NUMBER over real COPY/RUN directives, not by substring position: "package.json" also
  // appears in this file's own prose, and matching that made the check fail on a correct Dockerfile.
  const lines = dockerfile.split("\n");
  const lineOf = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const lastLineOf = (re: RegExp) => lines.reduce((hit, l, i) => (re.test(l) ? i : hit), -1);
  const install = lineOf(/^RUN\s+pnpm install/);
  const lastManifest = lastLineOf(/^COPY\s+\S+\/package\.json\s/);
  const source = lineOf(/^COPY\s+\.\s+\.\s*$/);
  assert.ok(install > 0, "expected a `RUN pnpm install` line");
  assert.ok(source > 0, "expected a `COPY . .` line");
  assert.ok(lastManifest < install, "every manifest COPY must sit ABOVE `pnpm install`");
  assert.ok(source > install, "`COPY . .` must sit BELOW `pnpm install`, or every edit reinstalls");
});

test(".dockerignore keeps the giants out of the build context", () => {
  const ignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // Each of these was measured in the context before it was excluded. crcon-db-data is the
  // least obvious: the import runbook tells operators to paste a multi-gigabyte CRCON backup
  // there, it sits at the repo root, and the build context is the repo root — so it shipped to
  // the daemon on every rebuild despite the build never reading it. `backups` is worse in one
  // way: it grows BY ITSELF (every full backup and trim archive lands there), so an install
  // that starts light creeps toward a multi-gigabyte transfer — 4 GB on a live install — with
  // nobody having pasted anything.
  for (const must of ["node_modules", ".turbo", ".git", "crcon-db-data", "backups"]) {
    assert.ok(ignore.includes(must), `.dockerignore must exclude ${must} from the build context`);
  }
});

// API_PORT in infra/.env is the port on the host: the left side of the api's port mapping. The
// compose file hands every line of infra/.env to the container as well, and the app reads API_PORT
// before PORT, so a host port of 8081 had the API listening on 8081 inside the container, where the
// mapping sends nothing, and the panel never answered. Read here the way the container gets it:
// infra/.env's lines, with the service's own `environment:` on top.
test("a host port set in infra/.env moves only the mapping, not the port the API listens on inside", () => {
  const compose = readFileSync(join(repoRoot, "infra", "docker-compose.yml"), "utf8");
  const api = compose.slice(compose.indexOf("\n  api:"), compose.indexOf("\n  worker:"));
  const inside = /^ {6}- "\$\{API_PORT:-8080\}:(\d+)"$/m.exec(api)?.[1];
  assert.ok(inside, "the api's port mapping moved: retarget this test");
  const block = /\n {4}environment:\n((?: {6}.*\n|\s*\n)*)/.exec(api)?.[1] ?? "";
  const environment = Object.fromEntries([...block.matchAll(/^ {6}([A-Z_]+): (.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
  assert.ok("PORT" in environment, "the api's environment block was not found: retarget this test");
  for (const hostPort of ["8080", "8081"]) {
    assert.equal(loadApiConfig({ API_PORT: hostPort, ...environment }).port, Number(inside), `with API_PORT=${hostPort} in infra/.env`);
  }
});
