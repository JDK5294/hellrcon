import { hasPlaceholders, messageRenderer, type MessageRenderer, type Repository, type ServerRow } from "@app/db";
import { getGame, liveFactsFor } from "@app/games";
import { prettifyMapId } from "@app/maps";
import { ObserveModeViolation, createServerClient, type StateKind } from "@app/rcon-core";

type StateReader = { readState(kind: StateKind): Promise<unknown> };

/**
 * A live reader for a path that holds no open connection (an enforcer rule, a player trigger):
 * each read opens a short connection and closes it. Only ever called when a message actually
 * uses a live placeholder — the renderer asks for nothing otherwise — and it caches per batch.
 */
function oneShotReader(server: ServerRow): StateReader {
  return {
    async readState(kind) {
      const game = getGame(server.game);
      const client = createServerClient({ protocol: server.protocol, engagementMode: server.engagementMode, commands: game?.commands, lineKey: game?.logLineKey });
      try {
        await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined });
        return await client.readState(kind);
      } finally {
        await client.disconnect().catch(() => {});
      }
    },
  };
}

/**
 * The placeholder renderer for one server — WW2 or Vietnam alike: the game (whose ids a
 * "{vip_until:<server>}" crosses from), live reads through the game's own readers, and map ids
 * named the way the panel names them. Pass the open `client` when there is one.
 */
export function rendererFor(repo: Repository, server: ServerRow, client?: StateReader | null, opts: { vipPerPlayer?: boolean } = {}): MessageRenderer {
  return messageRenderer(repo, {
    serverId: server.id, serverName: server.name, game: server.game,
    live: liveFactsFor(client ?? oneShotReader(server), server.game),
    mapLabel: prettifyMapId,
    ...(opts.vipPerPlayer ? { vipPerPlayer: true } : {}),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One player message in a batch, sent the way a batch must send it: one retry after a short
 * pause (a busy server drops the odd send when many arrive together — the field report was "the
 * message won't get sent every time"), and never a retry for observe mode, which refuses on
 * purpose. Throws if both attempts fail, so the caller can report that player honestly.
 */
export async function sendPlayerMessage(client: { execute(cmd: string, params: Record<string, unknown>): Promise<unknown> }, playerId: string, message: string): Promise<void> {
  try {
    await client.execute("messagePlayer", { playerId, message });
  } catch (err) {
    if (err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation") throw err;
    await sleep(500);
    await client.execute("messagePlayer", { playerId, message });
  }
}
export { sleep as pauseMs };

/**
 * An action's player-facing text — the kick/ban `reason`, the admin-message `message` — with its
 * placeholders filled for this player on this server ({player_name}, {vip_until}, {server_name}…,
 * see @app/db placeholders). Returned untouched, with no reads, when neither text uses one. Pass
 * a `renderer` when acting on many players at once so the batch shares one set of reads.
 */
export async function renderActionText(
  repo: Repository,
  server: ServerRow,
  params: Record<string, unknown>,
  player: { playerId: string; playerName?: string | null },
  renderer?: MessageRenderer | null,
  client?: StateReader | null,
): Promise<Record<string, unknown>> {
  const keys = (["reason", "message"] as const).filter((k) => typeof params[k] === "string" && hasPlaceholders(params[k] as string));
  if (!keys.length) return params;
  const r = renderer ?? rendererFor(repo, server, client);
  const out = { ...params };
  for (const k of keys) out[k] = await r.render(params[k] as string, player);
  return out;
}
