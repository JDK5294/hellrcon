/**
 * crcon-bridge adapter — reads a server through an existing CRCON instance's HTTP API instead
 * of opening our own RCON socket. This is the coexistence path: in `observe` mode a community
 * that already runs CRCON can be sourced with ZERO extra game connections.
 *
 * Read-mostly by design (`canWrite = false`): all writes are refused here regardless of
 * engagement mode, so bridging can never issue a state-changing command through someone else's
 * CRCON. Log lines come back as CRCON's `raw` field — the original game text — so they feed the
 * exact same normalizer as a direct connection.
 */
import { CrconClient } from "./client.js";
import type { CommandTable, RconAdapter, ServerConn, StateKind, StreamOptions, Unsubscribe } from "../../types.js";

/**
 * CRCON's player payloads speak CRCON's own vocabulary — team as "allies"/"axis", role as an
 * hllrcon enum name lowercased ("heavymachinegunner", "armycommander") — while every consumer of
 * a roster read (player identity, the live view, the stats sampler, squad composition) reads the
 * game protocol's shape: numeric team/role, `iD`, `scoreData` with the server's own `cOMBAT`
 * spelling. Returning CRCON's dicts verbatim meant none of them could read a bridge-sourced
 * roster — no player identity, no sampled stats, no composition; the observe path silently
 * recorded nothing. These tables translate CRCON's strings back to the protocol values a direct
 * connection would have reported. CRCON is HLL-only (so is this adapter), and the vocabulary is
 * fixed by CRCON's hllrcon dependency (data/roles.py `name.lower()`), not by our game modules.
 */
const CRCON_TEAM_VALUES: Record<string, number> = { allies: 1, axis: 0 };
const CRCON_ROLE_IDS: Record<string, number> = {
  rifleman: 0, assault: 1, automaticrifleman: 2, medic: 3, spotter: 4,
  support: 5, heavymachinegunner: 6, antitank: 7, engineer: 8, officer: 9,
  sniper: 10, crewman: 11, tankcommander: 12, armycommander: 13,
  artilleryobserver: 14, operator: 15, gunner: 16,
};

/** CRCON detailed-player dict → the roster row shape a direct v2 connection reports. */
export function normalizeCrconPlayer(d: Record<string, unknown>): Record<string, unknown> {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const platformId = String(d.player_id ?? "").trim();
  const teamStr = typeof d.team === "string" ? d.team : "";
  const roleStr = typeof d.role === "string" ? d.role : "";
  const unit = String(d.unit_name ?? "");
  return {
    name: String(d.name ?? ""),
    iD: platformId,
    // `platform` rides through from the game's own payload when CRCON kept it; otherwise the id's
    // shape is the only evidence (17-digit numeric = Steam64).
    platform: String(d.platform ?? (/^\d{17}$/.test(platformId) ? "steam" : "unknown")),
    ...(d.clan_tag ? { clanTag: String(d.clan_tag) } : {}),
    ...(d.eos_id ? { eosId: String(d.eos_id) } : {}),
    // An unknown team or role string stays null — "CRCON said something new" must degrade to
    // "unassigned", never to NaN keys in the role clocks downstream.
    team: CRCON_TEAM_VALUES[teamStr] ?? null,
    role: CRCON_ROLE_IDS[roleStr] ?? null,
    level: num(d.level),
    loadout: String(d.loadout ?? ""),
    // CRCON synthesizes "command"/"unassigned" for players outside a lettered squad; the protocol
    // reports an empty platoon there. Uppercased to match the wire's own spelling ("ABLE").
    platoon: unit && unit !== "command" && unit !== "unassigned" ? unit.toUpperCase() : "",
    scoreData: { cOMBAT: num(d.combat), offense: num(d.offense), defense: num(d.defense), support: num(d.support) },
    stats: {
      infantryKills: num(d.kills), deaths: num(d.deaths), teamKills: num(d.team_kills),
      vehicleKills: num(d.vehicle_kills), vehiclesDestroyed: num(d.vehicles_destroyed),
    },
    ...(d.world_position && typeof d.world_position === "object" ? { worldPosition: d.world_position } : {}),
  };
}

/** Pull the per-player dicts out of `get_detailed_players` (`{ players: { id: {…} }, fail_count }`). */
export function extractDetailedPlayers(result: unknown): Record<string, unknown>[] {
  const players = (result as { players?: unknown } | null)?.players;
  if (players && typeof players === "object" && !Array.isArray(players)) {
    return Object.values(players).filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
  }
  return [];
}

export class CrconBridgeAdapter implements RconAdapter {
  readonly protocol = "crcon-bridge" as const;
  readonly canWrite = false;
  private client: CrconClient | null = null;

  /** the game module's command table; used only to classify writes (bridge refuses them all). */
  constructor(
    readonly commands: CommandTable = {},
    /** stable per-event line identity for stream dedup (game modules supply theirs). */
    private readonly lineKey: (line: string) => string = (l) => l,
  ) {}

  async connect(conn: ServerConn): Promise<void> {
    if (!conn.crconBaseUrl) throw new Error("crcon-bridge requires crconBaseUrl (the existing CRCON instance URL)");
    const client = new CrconClient({ baseUrl: conn.crconBaseUrl, apiKey: conn.password, timeoutMs: conn.timeoutMs });
    await client.get("get_gamestate"); // validate URL + API key up front (throws on 401/403/unreachable)
    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  async execute(command: string, _params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error("adapter not connected");
    if (this.commands[command]?.access === "write") throw new Error("crcon-bridge is read-only; issue writes on a directly-connected (active) server");
    switch (command) {
      case "getPlayers":
        return this.readPlayers();
      case "getSession":
        return this.client.get("get_gamestate");
      case "getObjectives":
        throw new Error("crcon-bridge does not expose objectives; use a direct connection for that");
      case "getAdminLog":
        return this.client.get("get_recent_logs", { end: 500 });
      default:
        throw new Error(`crcon-bridge cannot run command '${command}'`);
    }
  }

  /**
   * Roster read: `get_detailed_players` first — the only CRCON endpoint that carries team, role,
   * level and the score buckets, i.e. the fields the stats sampler and live view exist to read —
   * with plain `get_players` as the fallback so an older CRCON still yields identity and names.
   */
  private async readPlayers(): Promise<Record<string, unknown>[]> {
    if (!this.client) throw new Error("adapter not connected");
    try {
      const detailed = await this.client.get("get_detailed_players");
      return extractDetailedPlayers(detailed).map(normalizeCrconPlayer);
    } catch {
      const basic = await this.client.get("get_players");
      const list = Array.isArray(basic) ? (basic as Record<string, unknown>[]) : [];
      return list.map((p) => {
        // First NON-EMPTY of the spellings, not `??` — an empty `player_id` beside a real id must
        // not erase the player (the same wire quirk rosterPlayerId guards against).
        const platformId = [p?.player_id, p?.iD, p?.id].map((x) => String(x ?? "").trim()).find((x) => x) ?? "";
        return { name: String(p?.name ?? ""), iD: platformId, platform: /^\d{17}$/.test(platformId) ? "steam" : "unknown" };
      });
    }
  }

  async raw(input: { command: string }): Promise<{ content: string }> {
    if (!this.client) throw new Error("adapter not connected");
    // For the bridge, a "raw" command is a CRCON API path (e.g. get_vip_ids).
    const result = await this.client.get(input.command.replace(/^\/?(api\/)?/, ""));
    return { content: JSON.stringify(result, null, 2) };
  }

  readState(kind: StateKind): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error("adapter not connected"));
    switch (kind) {
      case "players":
        return this.readPlayers();
      case "session":
        return this.client.get("get_gamestate");
      case "maprotation":
        // CRCON flattens the protocol's answer to `{ maps: [id…], current_index }`; the game's own
        // reader already accepts that alongside the raw `{ mAPS: [{iD}], currentIndex }`, so this
        // needs no translation. It was simply never wired: the kind fell through to `default` and
        // rejected as "unknown", and since every caller tolerates a failed rotation read, a
        // bridge-sourced server showed an empty rotation everywhere with nothing said about why.
        return this.client.get("get_map_rotation");
      case "objectives":
        return Promise.reject(new Error("crcon-bridge does not expose objectives"));
      default:
        return Promise.reject(new Error(`unknown state kind: ${String(kind)}`));
    }
  }

  async readLogLines(seconds = 65): Promise<string[]> {
    if (!this.client) throw new Error("adapter not connected");
    const logs = await this.client.recentLogs(500);
    const cutoff = Date.now() - seconds * 1000;
    return logs
      .filter((l) => typeof l.timestamp_ms !== "number" || l.timestamp_ms >= cutoff) // honor the window when timestamps are present
      .map((l) => (l.raw ?? "").trim())
      .filter(Boolean);
  }

  streamLogs(onLine: (raw: string) => void, opts: StreamOptions = {}): Unsubscribe {
    const intervalMs = opts.intervalMs ?? 5_000;
    const seen = new Set<string>();
    let stopped = false;

    const tick = async () => {
      if (stopped || !this.client) return;
      try {
        const lines = await this.readLogLines(Math.ceil(intervalMs / 1000) + 5);
        for (const line of lines) {
          const key = this.lineKey(line); // stable across polls even though CRCON re-lists recent logs
          if (seen.has(key)) continue;
          seen.add(key);
          onLine(line);
        }
        if (seen.size > 5000) seen.clear();
      } catch {
        // transient read failure; the next tick retries
      }
    };

    const handle = setInterval(() => void tick(), intervalMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}
