/**
 * Server auto-discovery from environment variables.
 *
 * A server defined via environment variables, for auto-discovery. The app never hardcodes
 * servers — but an operator can seed them from the environment (handy for docker-compose /
 * hosted deploys) instead of adding each one through the UI. On startup these are upserted
 * into the repository (idempotently, keyed by host:port) in read-only `observe` mode.
 *
 *   SERVER_1_HOST=1.2.3.4
 *   SERVER_1_PORT=28865
 *   SERVER_1_PASSWORD=secret
 *   SERVER_1_GAME=hll               # optional; which game this server runs, defaults to hll
 *   SERVER_1_PROTOCOL=binary-v2     # optional; defaults to the game's first protocol
 *   SERVER_1_HEADER_MODE=magic      # optional (magic|legacy), defaults to magic
 *   SERVER_1_NAME=My Server         # optional; the live name is pulled from RCON anyway
 *   SERVER_1_CRCON_URL=https://…    # crcon-bridge only: the existing CRCON to read through
 *
 * Indices need not be contiguous — every SERVER_<n>_HOST present is discovered.
 *
 * GAME and PROTOCOL are carried as raw strings and validated by the caller against the game-module
 * registry, because that registry lives above this package and validation must happen exactly once
 * — in `discoverServersFromEnv`, which refuses an unknown game rather than seeding a server the
 * app would then misread. Getting the game wrong is silent and damaging: HLL: Vietnam speaks HLL's
 * RCON wire for wire, so a mislabelled Vietnam server connects happily and is then read with the
 * wrong roles, sides, weapons and player-identity rule.
 */
export interface ServerEnvEntry {
  index: number;
  name?: string;
  host: string;
  port: number;
  password: string;
  headerMode: "magic" | "legacy";
  /** raw `SERVER_<n>_GAME`, lower-cased; undefined when unset. Validated by the caller. */
  game?: string;
  /** raw `SERVER_<n>_PROTOCOL`, lower-cased; undefined when unset. Validated by the caller. */
  protocol?: string;
  /** crcon-bridge only: the existing CRCON instance to read through. */
  crconBaseUrl?: string;
}

/** Parse SERVER_<n>_* variables into discovery entries (pure; no I/O, no registry lookups). */
export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnvEntry[] {
  const indices = new Set<number>();
  for (const key of Object.keys(env)) {
    const m = /^SERVER_(\d+)_HOST$/.exec(key);
    if (m) indices.add(Number(m[1]));
  }
  const entries: ServerEnvEntry[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const host = env[`SERVER_${index}_HOST`]?.trim();
    const port = Number(env[`SERVER_${index}_PORT`]);
    const password = env[`SERVER_${index}_PASSWORD`];
    if (!host || !port || !password) continue; // incomplete entry — skip, don't guess
    const headerMode = env[`SERVER_${index}_HEADER_MODE`]?.trim() === "legacy" ? "legacy" : "magic";
    const name = env[`SERVER_${index}_NAME`]?.trim() || undefined;
    const game = env[`SERVER_${index}_GAME`]?.trim().toLowerCase() || undefined;
    const protocol = env[`SERVER_${index}_PROTOCOL`]?.trim().toLowerCase() || undefined;
    const crconBaseUrl = env[`SERVER_${index}_CRCON_URL`]?.trim() || undefined;
    entries.push({ index, name, host, port, password, headerMode, game, protocol, crconBaseUrl });
  }
  return entries;
}
