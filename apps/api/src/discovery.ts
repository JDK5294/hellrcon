/**
 * Server auto-discovery + live-name resolution.
 *
 * Two things live here:
 *
 *  1. `discoverServersFromEnv` — on startup, seed servers from SERVER_<n>_* env vars so an
 *     operator can define servers in `infra/.env` (docker-compose / hosted) instead of adding
 *     each through the UI. Idempotent: keyed on host:port, existing servers are left alone.
 *     Everything starts in read-only `observe` mode (safe next to an existing setup).
 *
 *  2. `resolveServerName` — pull a server's *live* name from RCON. Providers such as GTX let
 *     admins rename a server over RCON/CRCON, so the RCON name is authoritative; we prefer it
 *     over whatever was typed at add-time and refresh it opportunistically.
 *
 * Name resolution touches the network, so it never blocks startup and never throws upward —
 * a server that's unreachable is simply left with its fallback name until the next refresh.
 */
import { createServerClient, serverNameFromSession } from "@app/rcon-core";
import { getGame, listGames } from "@app/games";
import type { Repository, ServerRow } from "@app/db";
import type { RconProtocol, ServerEnvEntry } from "@app/shared";
import { createLogger, parseServerEnv } from "@app/shared";

const log = createLogger("discovery");

/** Connect read-only, read `session`, and return the live server name (or null). */
export async function fetchLiveServerName(server: ServerRow, timeoutMs = 8000): Promise<string | null> {
  const client = createServerClient({ protocol: server.protocol, engagementMode: "observe", commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey });
  try {
    await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined, timeoutMs });
    const session = await client.readState("session");
    return serverNameFromSession(session);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Refresh a server's stored name from RCON if it differs. Best-effort: returns the resolved
 * name on success, null if unreachable or no name was found. Never throws.
 */
export async function resolveServerName(repo: Repository, server: ServerRow, timeoutMs = 8000): Promise<string | null> {
  try {
    const live = await fetchLiveServerName(server, timeoutMs);
    // Compared against the game's OWN name — `name` may be the staff nickname, and comparing the
    // live read against that would rewrite the stored name on every resolve.
    if (live && live !== server.gameName) {
      await repo.servers.updateName(server.id, live);
      log.info("server name updated from RCON", { serverId: server.id, name: live });
    }
    return live;
  } catch (err) {
    log.warn("could not resolve server name from RCON", { serverId: server.id, host: server.host, port: server.port, err: (err as Error).message });
    return null;
  }
}

export interface DiscoveryResult {
  created: ServerRow[];
  existing: ServerRow[];
  /** entries refused because their game/protocol could not be honoured, with the reason. */
  skipped: { index: number; host: string; port: number; reason: string }[];
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  /** resolve live names from RCON in the background (default true; tests pass false). */
  resolveNames?: boolean;
}

/**
 * Upsert every SERVER_<n>_* entry from the environment. New servers are created in `observe`
 * mode; existing ones (matched by host:port) are left untouched. Live names are then resolved
 * from RCON in the background so a slow/unreachable server never delays startup.
 *
 * The game and protocol are validated against the module registry here — the one place that can,
 * and the same rules the Add Server route applies. An entry naming a game we have no module for
 * is REFUSED, not defaulted: seeding it as HLL would produce a server that connects fine and is
 * then read with the wrong roles, sides, weapons and identity rule, which is far harder to notice
 * than a startup error. An entry that names no game still defaults to `hll` (every deployment
 * predating multi-game support relies on that) but says so in the log, because with more than one
 * game registered that default is an assumption rather than a fact.
 */
export async function discoverServersFromEnv(repo: Repository, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const env = opts.env ?? process.env;
  const resolveNames = opts.resolveNames ?? true;
  const entries = parseServerEnv(env);
  const created: ServerRow[] = [];
  const existing: ServerRow[] = [];
  const skipped: DiscoveryResult["skipped"] = [];
  /** servers an env block accounted for this pass — the rest are "unexplained" below. */
  const matched = new Set<string>();
  /** entries that matched nothing, held back until every other entry has claimed what it can. */
  const unmatched: { entry: ServerEnvEntry; where: { index: number; host: string; port: number }; gameId: string; protocol: RconProtocol }[] = [];

  for (const entry of entries) {
    const where = { index: entry.index, host: entry.host, port: entry.port };
    const refuse = (reason: string) => {
      skipped.push({ ...where, reason });
      log.error("env server refused", { ...where, reason });
    };

    // --- game: must have a module, or we cannot read this server correctly ---
    const gameId = entry.game ?? "hll";
    const mod = getGame(gameId);
    if (!mod) {
      refuse(`SERVER_${entry.index}_GAME='${gameId}' is not a game this build knows (known: ${listGames().map((g) => g.id).join(", ")})`);
      continue;
    }
    if (!entry.game) {
      log.info("env server did not name a game — assuming hll", { ...where, hint: `set SERVER_${entry.index}_GAME to be explicit` });
    }

    // --- protocol: must be one this game speaks; unset takes the game's own first choice ---
    const protocol = (entry.protocol ?? mod.protocols[0]?.id ?? "binary-v2") as RconProtocol;
    if (!mod.protocols.some((p) => p.id === protocol)) {
      refuse(`SERVER_${entry.index}_PROTOCOL='${protocol}' is not supported by ${mod.label} (supported: ${mod.protocols.map((p) => p.id).join(", ")})`);
      continue;
    }
    // crcon-bridge reads THROUGH an existing CRCON, so without its URL the row would be unusable.
    if (protocol === "crcon-bridge" && !entry.crconBaseUrl) {
      refuse(`SERVER_${entry.index}_PROTOCOL=crcon-bridge also needs SERVER_${entry.index}_CRCON_URL (the existing CRCON instance)`);
      continue;
    }

    /*
     * Which server is this env block talking about?
     *
     * The SLOT is the identity — SERVER_2 seeds one server, forever. The address is not: a host can
     * move a server to a new ip, port and password and it is still the same server, with the same
     * records, bans, stats and settings, wearing a new face. Matching on the address made a moved
     * server look unknown, so the next boot re-seeded this block as a SECOND, empty server while
     * the real one sat unreachable beside it holding all the history.
     *
     * Address is kept as the FALLBACK for servers seeded before slots were recorded, and matching
     * that way adopts the slot, so an install is stamped on its next boot and protected from then
     * on. (Renumbering the SERVER_<n> blocks re-points the mapping, which is the same
     * seed-a-new-server behaviour the env had before — a deliberate config act, not a surprise.)
     */
    const found = (await repo.servers.findBySeedSlot(entry.index))
      ?? (await repo.servers.findByHostPort(entry.host, entry.port));
    if (found) {
      if (found.seedSlot === null) await repo.servers.claimSeedSlot(found.id, entry.index);
      // Already known: the env is a SEED, not a source of truth, so nothing is overwritten. Say so
      // when the env now disagrees with the stored game, since that is a real config surprise —
      // and name the fix, because the game can be corrected from the panel.
      if (found.game !== gameId) {
        log.warn("env names a different game than the stored server — keeping the stored one", {
          ...where, stored: found.game, env: gameId, hint: "change it under Administration → Connections if the env is right",
        });
      }
      // Same for the address. This is the moved-server case and it is now a note rather than a
      // duplicate: the panel holds the connection the app actually dials, and the env is only
      // ever consulted to decide whether a server needs creating in the first place.
      if (found.host !== entry.host || found.port !== entry.port) {
        log.warn("env names a different address than the stored server — keeping the stored one", {
          ...where, stored: `${found.host}:${found.port}`, server: found.name,
          hint: "the panel is the source of truth for a server's connection — change it under Administration → Connections, or update the env to match",
        });
      }
      existing.push(found);
      matched.add(found.id);
      continue;
    }
    // Nothing matched. Whether that means "a new server" or "a server that moved" cannot be decided
    // until every other entry has had its turn — see the second pass below.
    unmatched.push({ entry, where, gameId, protocol });
  }

  /*
   * The entries that matched nothing.
   *
   * A block that matches neither a slot nor an address is either a genuinely new server or one that
   * MOVED before it was ever stamped with its slot — and from here those look identical. Creating
   * one is a guess, and guessing wrong is the expensive direction: it invents an empty duplicate,
   * starts writing this server's records to it, and leaves the real server sitting unreachable
   * beside it holding all the history. That is the exact failure the slot exists to prevent, and it
   * is still reachable on the FIRST boot after this upgrade, when nothing carries a slot yet and
   * the address is all there is to go on — which is precisely the boot where an operator has
   * already put a new address in the env for a server the database still lists at the old one.
   *
   * So: while an unexplained server is sitting there — one with no slot that no env block claimed —
   * a block that matches nothing does not create anything. It says what it found, names both
   * candidates, and leaves the decision to a human, because a human can tell "moved" from "new" in
   * a second and the app cannot tell it at all. Nothing is lost by waiting: the server is added
   * from the panel, or its address corrected there, and the next boot matches it.
   *
   * A first install has no servers at all, so nothing is unexplained and seeding works exactly as
   * it always has — which is the case the env exists for.
   */
  for (const { entry, where, gameId, protocol } of unmatched) {
    const orphans = (await repo.servers.list()).filter((s) => s.seedSlot === null && !matched.has(s.id));
    if (orphans.length) {
      const reason =
        `SERVER_${entry.index} names ${entry.host}:${entry.port}, which matches no server this app knows. `
        + `It was NOT created, because ${orphans.length === 1 ? "a server is" : `${orphans.length} servers are`} `
        + `already here that no environment block accounts for (${orphans.map((s) => `"${s.name}" at ${s.host}:${s.port}`).join(", ")}) `
        + `— and creating one now would invent a duplicate if this block is really one of them under a new address. `
        + `If this server MOVED, set its new address under Administration → Connections. If it is genuinely new, add it there too.`;
      skipped.push({ ...where, reason });
      log.warn("env server not created — it may be an existing server that moved", { ...where, candidates: orphans.map((s) => `${s.name} @ ${s.host}:${s.port}`) });
      continue;
    }
    const row = await repo.servers.create({
      name: entry.name ?? `${entry.host}:${entry.port}`,
      game: gameId,
      host: entry.host,
      port: entry.port,
      password: entry.password,
      protocol,
      headerMode: entry.headerMode,
      crconBaseUrl: entry.crconBaseUrl ?? null,
      // Stamped at birth, so this server is recognisable as "the one SERVER_<n> seeded" no matter
      // where it later moves to.
      seedSlot: entry.index,
      // engagement mode intentionally omitted — defaults to observe (read-only, safe).
    });
    created.push(row);
    matched.add(row.id);
  }

  if (entries.length) {
    log.info("env discovery complete", { discovered: entries.length, created: created.length, existing: existing.length, skipped: skipped.length });
  }

  // Resolve live names in the background for everything we know about — never blocks startup.
  const all = [...created, ...existing];
  if (resolveNames && all.length) {
    void Promise.allSettled(all.map((s) => resolveServerName(repo, s)));
  }

  return { created, existing, skipped };
}
