#!/usr/bin/env node
// Phase 1 observe runner: reads a server's RCON details from infra/.env and runs the
// read-only observe harness against it. Never writes to the server (observe mode).
//
//   node scripts/observe.mjs [serverNumber]     (defaults to 1)
//
// Secrets stay in infra/.env (git-ignored). Nothing here is committed.

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "infra", ".env");
const HARNESS = join(ROOT, "packages", "games", "dist", "dev", "observe.js");

function parseEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const n = process.argv[2] ?? "1";
const env = parseEnv(ENV_PATH);
const host = env[`SERVER_${n}_HOST`];
const port = env[`SERVER_${n}_PORT`];
const password = env[`SERVER_${n}_PASSWORD`];
const headerMode = env[`SERVER_${n}_HEADER_MODE`] ?? "magic";

if (!existsSync(HARNESS)) {
  console.error("Build first:  pnpm install && pnpm build");
  process.exit(1);
}
if (!host || !port || !password) {
  console.error(`Missing SERVER_${n}_HOST/PORT/PASSWORD in infra/.env`);
  console.error("Copy infra/.env.example to infra/.env and fill in your server details.");
  process.exit(1);
}

console.log(`Observing server ${n} (${host}:${port}) in READ-ONLY mode. Ctrl+C to stop.\n`);
spawn(process.execPath, [HARNESS], {
  stdio: "inherit",
  env: {
    ...process.env,
    RCON_HOST: host,
    RCON_PORT: port,
    RCON_PASSWORD: password,
    RCON_HEADER_MODE: headerMode,
    RCON_SERVER_ID: `srv-${n}`,
  },
});
