/**
 * The plays-left countdown on a saved Vietnam objective layout: the decision half
 * (`planLayoutExpiryTick`, pure) and the tick that reads, plans and clears (`runLayoutExpiryTick`,
 * its I/O injected so the tests can drive it on the in-memory store and a fake game).
 *
 * The game stores a layout FOREVER (docs/hll-vietnam.md p11 has no expiry), so "keep it for the
 * next N plays" is entirely ours: a row per (server, map) that this tick decrements each time a
 * NEW round of that map is found open, and at zero the executor sends RemoveSectorLayout — back
 * to the server's own random picks.
 *
 * The rules that are not obvious, written down where the tests can hold them:
 *
 *  - **One round is never counted twice.** `lastMatchId` remembers the match that consumed a
 *    play; a tick that sees the same open match again does nothing. It starts as the match that
 *    was already RUNNING when the layout was saved, because Vietnam's save does not restart the
 *    round — that round rolled its objectives before the layout existed and must not count.
 *  - **The Nth play still gets the layout.** The game applied the stored layout when the round
 *    loaded; clearing DURING that round only changes what the round after it does. So the clear
 *    fires the moment the count hits zero, not one round later.
 *  - **Rounds of OTHER maps don't count and don't touch the row.** The countdown is plays of the
 *    map the layout belongs to.
 *  - **A refusal is a retry, not a loss.** If the game cannot be reached for the clear, the row
 *    stays at zero and every following tick offers it again — same posture as the VIP sweep.
 *  - **Observe mode holds the clear.** The count still advances (rounds really happened), but a
 *    read-only server is never written to; the clear fires on the first tick after it is Active.
 */
import { zoneKeyOf } from "@app/maps";
import type { ObjectiveLayoutExpiryRow, Repository, ServerRow } from "@app/db";
import type { SweepLog } from "./sweeps.js";

export interface LayoutExpiryContext {
  /** The server a row belongs to — null/undefined when it no longer exists. */
  serverOf(serverId: string): ServerRow | null | undefined;
  /** The round open on that server right now (id + map), or null when none is. */
  openMatchOf(serverId: string): { id: string; map: string | null } | null | undefined;
}

export interface LayoutExpiryTick {
  /** Rows whose server is gone: drop them, tell nobody. */
  orphans: ObjectiveLayoutExpiryRow[];
  /** A new play of the map was found: persist the decremented count. */
  counted: { row: ObjectiveLayoutExpiryRow; playsLeft: number; lastMatchId: string }[];
  /** Countdowns at zero on an ACTIVE server: send RemoveSectorLayout, then delete + audit. */
  clears: ObjectiveLayoutExpiryRow[];
}

export function planLayoutExpiryTick(rows: ObjectiveLayoutExpiryRow[], ctx: LayoutExpiryContext): LayoutExpiryTick {
  const out: LayoutExpiryTick = { orphans: [], counted: [], clears: [] };
  for (const row of rows) {
    const server = ctx.serverOf(row.serverId);
    if (!server) { out.orphans.push(row); continue; }

    let playsLeft = row.playsLeft;
    const open = ctx.openMatchOf(row.serverId);
    // By FAMILY, never by spelling: the expiry row holds the session's map id
    // ("vantuong_warfare") while match rows hold the admin log's display text ("MATCH START
    // Van Tuong Warfare") — a literal compare never matches anything real, and the countdown
    // would sit at N forever looking perfectly healthy. zoneKeyOf folds every spelling either
    // side speaks (ids, accented display names, mode suffixes) to the same family key.
    const fam = zoneKeyOf(row.mapId);
    if (open?.map && fam && zoneKeyOf(open.map) === fam && open.id !== row.lastMatchId) {
      playsLeft = Math.max(0, playsLeft - 1);
      out.counted.push({ row, playsLeft, lastMatchId: open.id });
    }
    // Due rows include ones counted to zero THIS tick and ones a failed clear left at zero
    // earlier; both wait out observe mode rather than writing to a read-only server.
    if (playsLeft <= 0 && server.engagementMode === "active") {
      out.clears.push({ ...row, playsLeft });
    }
  }
  return out;
}

/** The slice of a game client the clear uses — so a test can hand in a fake. */
export interface LayoutExpiryClient {
  connect(): Promise<unknown>;
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface LayoutExpiryDeps {
  repo: Repository;
  /** A client for one server, already pointed at it: `connect()` takes no arguments. */
  clientFor(server: ServerRow): LayoutExpiryClient;
  log: SweepLog;
}

/**
 * One tick of the sweep. DB-only until a countdown actually reaches zero; the game is dialed only
 * to clear.
 */
export async function runLayoutExpiryTick(deps: LayoutExpiryDeps): Promise<void> {
  const { repo, log } = deps;
  const rows = await repo.layoutExpiries.list();
  if (!rows.length) return;
  const servers = await repo.servers.list();
  const byId = new Map(servers.map((sv) => [sv.id, sv]));
  const opens = new Map<string, { id: string; map: string | null } | null>();
  for (const row of rows) {
    if (!opens.has(row.serverId)) {
      const open = await repo.matches.getOpen(row.serverId).catch(() => null);
      opens.set(row.serverId, open ? { id: open.id, map: open.map } : null);
    }
  }
  const plan = planLayoutExpiryTick(rows, { serverOf: (id) => byId.get(id), openMatchOf: (id) => opens.get(id) });
  for (const o of plan.orphans) await repo.layoutExpiries.delete(o.serverId, o.mapId);
  for (const c of plan.counted) await repo.layoutExpiries.count(c.row.serverId, c.row.mapId, c.playsLeft, c.lastMatchId);
  for (const due of plan.clears) {
    const server = byId.get(due.serverId)!;
    const client = deps.clientFor(server);
    try {
      await client.connect();
      await client.execute("removeSectorLayout", { mapId: due.mapId });
    } catch (err) {
      // The row stays at zero and every following tick offers it again — a refusal is a retry,
      // never a lost clear (the same posture as the VIP sweep).
      log.warn("layout expiry could not clear a saved layout yet", { serverId: due.serverId, mapId: due.mapId, err: (err as Error).message });
      continue;
    } finally {
      await client.disconnect().catch(() => {});
    }
    await repo.layoutExpiries.delete(due.serverId, due.mapId);
    await repo.audit.create({
      actorUserId: null, actorName: "layout expiry", action: "map.objectives",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `cleared the saved objective layout for ${due.mapId} on ${server.name} — its play limit was reached, back to the server's own picks`,
      data: { mapId: due.mapId, cleared: true, auto: true, setBy: due.setBy },
    });
    log.info("layout expiry cleared a saved layout", { serverId: due.serverId, mapId: due.mapId });
  }
}
