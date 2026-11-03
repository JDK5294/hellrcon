import { messageRenderer, type MessageRenderer, type Repository, type ServerRow } from "@app/db";
import { liveFactsFor } from "@app/games";
import { prettifyMapId } from "@app/maps";
import type { StateKind } from "@app/rcon-core";

/** A placeholder renderer for one server — WW2 or Vietnam alike — reading the live session and
 *  rotation only if a text asks ({map_name}, {players_needed}, {next_map}…; see @app/db
 *  placeholders). `seedRound` counts a seed round being paid right now in {seed_count}. */
export function rendererFor(repo: Repository, server: ServerRow, client: { readState(kind: StateKind): Promise<unknown> }, seedRound?: string, vipPerPlayer = false): MessageRenderer {
  return messageRenderer(repo, {
    serverId: server.id, serverName: server.name, game: server.game,
    live: liveFactsFor(client, server.game),
    mapLabel: prettifyMapId,
    ...(seedRound ? { seedRound } : {}),
    ...(vipPerPlayer ? { vipPerPlayer: true } : {}),
  });
}
