/**
 * What the objective presets ("Map points", since removed) may have left on a game server.
 *
 * A Vietnam preset was stored on the game server just before its map change, and the worker put
 * back what had stood there once the new round had taken it. The pending row was the only record
 * of that duty, and left undone the preset would stand for every later play of the map, from every
 * surface, until somebody cleared it. So a row an install still holds after the update is finished
 * here: the layout from before put back, or the preset removed when nothing stood before it — but
 * only while the stored entry is still the preset's (planUndo); a layout staff set since is theirs
 * to keep. Then the row is forgotten.
 *
 * A WW2 row stored nothing on the game (its preset was still waiting for the map to load, and now
 * is simply never applied), so it is dropped, and so is a row whose server is gone. Nothing writes
 * rows any more, so this only drains: the caller stops asking once a sweep finds the table empty.
 * A retired server, or one in observe mode, is never written to; its row waits for it to be back.
 */
import type { MapPointPendingRow, Repository, ServerRow } from "@app/db";
import { parseStoredLayoutsStrict } from "@app/games";
import { forDuration, type QuietFailures } from "./quiet-failure.js";
import type { SweepLog } from "./sweeps.js";

/** A stored layout as GetSectorLayout listed it (see @app/games parseStoredLayoutsStrict). */
export interface StoredSectorLayout { mapId: string; sectors: number[] }

export type PutBackPlan =
  | { action: "restore"; sectors: number[] }
  | { action: "remove" }
  | { action: "none"; why: "gone" | "changed" };

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The entry stored under `mapId`: the exact spelling first, then any casing of it. */
function entryFor<T extends { mapId: string }>(entries: readonly T[], mapId: string): T | undefined {
  return entries.find((e) => e.mapId === mapId) ?? entries.find((e) => sameId(e.mapId, mapId));
}

/** Exactly five integer sector indices, each 0–2 — the only layout worth restoring. */
export function isValidSectors(x: unknown): x is number[] {
  return Array.isArray(x) && x.length === 5 && x.every((n) => Number.isInteger(n) && n >= 0 && n <= 2);
}

const sameSectors = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * What to send to undo a Vietnam preset, from a FRESH read of the stored list — compare before
 * restoring, because the stored layout belongs to staff again the moment the round has loaded:
 *
 *  - nothing stored under our map id → nothing to undo ("gone": someone cleared it already);
 *  - something else stored there than what we stored → staff changed it; leave it alone ("changed");
 *  - still ours → put back the layout that was there before (`restore`), or remove ours when there
 *    was none. A restore that is not five valid indices counts as none.
 *
 * Takes the pending row's nullable columns as they come: a row that never recorded where it
 * stored is "gone" (nothing of ours to find), and one that never recorded WHAT it stored cannot
 * prove the entry is ours, so it is left alone like a staff change — never restored over blind.
 */
export function planPutBack(input: {
  entries: readonly StoredSectorLayout[];
  storedMapId: string | null;
  storedIndices: readonly number[] | null;
  restore: readonly number[] | null;
}): PutBackPlan {
  const entry = input.storedMapId ? entryFor(input.entries, input.storedMapId) : undefined;
  if (!entry) return { action: "none", why: "gone" };
  if (!input.storedIndices || !sameSectors(entry.sectors, input.storedIndices)) return { action: "none", why: "changed" };
  return isValidSectors(input.restore) ? { action: "restore", sectors: [...input.restore] } : { action: "remove" };
}

/**
 * planPutBack for a press that may own more than one index list under the same key: its own, and
 * the lists of earlier presses it carried (a second press for the same map while the first's
 * layout was still stored kept the first's `restore`, and so inherited its duty to undo it).
 *
 * When a store's answer was lost (a timeout that actually landed, an unreadable read-back), the row
 * cannot know WHICH of its lists stands — and judging by one list alone would read the other as a
 * staff layout and leave the preset stored for every later play of that map.
 *
 *  - the row's own list is checked first; nothing stored under its map id wins outright ("gone");
 *  - else the first list of ours that still stands is undone, with the row's `restore` (a carried
 *    row's restore IS the layout from before the first press);
 *  - none of ours standing → "changed": staff's, left alone exactly as planPutBack would.
 *
 * Null entries in `alsoOurs` are skipped, so a caller can pass a row's nullable column as is.
 */
export function planUndo(
  entries: readonly StoredSectorLayout[],
  row: { storedMapId: string | null; storedIndices: readonly number[] | null; restore: readonly number[] | null },
  alsoOurs: readonly (readonly number[] | null)[],
): PutBackPlan {
  const first = planPutBack({ entries, storedMapId: row.storedMapId, storedIndices: row.storedIndices, restore: row.restore });
  if (first.action !== "none" || first.why === "gone") return first;
  for (const ours of alsoOurs) {
    if (!ours) continue;
    const alt = planPutBack({ entries, storedMapId: row.storedMapId, storedIndices: ours, restore: row.restore });
    if (alt.action !== "none") return alt;
  }
  return first;
}

/** What one leftover row needs. Pure: the sweep does the I/O each step names. */
export type LeftoverStep =
  | { kind: "drop"; row: MapPointPendingRow; why: "ww2" | "orphan" }
  | { kind: "undo"; row: MapPointPendingRow; server: ServerRow }
  | { kind: "wait"; row: MapPointPendingRow; why: "retired" | "observe" };

export function planLeftover(row: MapPointPendingRow, server: ServerRow | null | undefined): LeftoverStep {
  if (!server) return { kind: "drop", row, why: "orphan" };
  // A WW2 preset waited for its map to load before anything was sent: nothing to undo.
  if (row.phase === "await_load") return { kind: "drop", row, why: "ww2" };
  // The put-back is a game write: a retired or read-only server keeps the row until it is back.
  if (server.retiredAt) return { kind: "wait", row, why: "retired" };
  if (server.engagementMode !== "active") return { kind: "wait", row, why: "observe" };
  return { kind: "undo", row, server };
}

/** The slice of a game client the sweep uses — so a test can hand in a fake. */
export interface LeftoverClient {
  connect(): Promise<unknown>;
  execute(command: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface LeftoverDeps {
  repo: Repository;
  clientFor(server: ServerRow): LeftoverClient;
  log: SweepLog;
  /** One warning when a server cannot be reached, then sparse repeats. */
  failures: QuietFailures;
  now(): number;
}

/** One sweep. True once nothing is left — the caller stops asking then. */
export async function runPresetLeftovers(deps: LeftoverDeps): Promise<boolean> {
  const { repo } = deps;
  const rows = await repo.mapPointPending.list();
  if (!rows.length) return true;
  const servers = new Map((await repo.servers.list({ includeRetired: true })).map((s) => [s.id, s]));
  for (const row of rows) {
    const step = planLeftover(row, servers.get(row.serverId));
    if (step.kind === "drop") await repo.mapPointPending.take(row.serverId, row.id);
    else if (step.kind === "undo") await undo(deps, step.server, row);
  }
  return false;
}

/**
 * Put back what the preset displaced. Read strictly (an unreadable list is a retry, never "nothing
 * stored") and compared before restoring (planUndo); on any failure the row stays for the next
 * sweep, because it is the only record of what to undo.
 */
async function undo(deps: LeftoverDeps, server: ServerRow, row: MapPointPendingRow): Promise<void> {
  const { repo, log } = deps;
  const failKey = `preset-leftovers:${server.id}`;
  const client = deps.clientFor(server);
  let plan: PutBackPlan;
  try {
    await client.connect();
    const entries = parseStoredLayoutsStrict(await client.execute("getObjectives"));
    if (!entries) throw new Error("the server's stored objective layouts could not be read");
    plan = planUndo(entries, row, [row.carriedIndices]);
    if (plan.action !== "none") {
      const mapId = entryFor(entries, row.storedMapId!)?.mapId ?? row.storedMapId!;
      if (plan.action === "restore") {
        const s = plan.sectors;
        await client.execute("setSectorLayout", { mapId, sector1Index: s[0], sector2Index: s[1], sector3Index: s[2], sector4Index: s[3], sector5Index: s[4] });
      } else {
        await client.execute("removeSectorLayout", { mapId });
      }
    }
  } catch (err) {
    const v = deps.failures.fail(failKey, deps.now());
    if (v.speak) log.warn(`could not put back a stored objective layout an objective preset left yet${v.runs > 1 ? ` (${v.runs} tries, ${forDuration(v.sinceMs)})` : ""} — retrying`, { serverId: server.id, err: (err as Error).message });
    return;
  } finally {
    await client.disconnect().catch(() => {});
  }
  deps.failures.ok(failKey, deps.now());
  await repo.mapPointPending.take(row.serverId, row.id);
  log.info("put back a stored objective layout an objective preset left", { serverId: server.id, mapId: row.storedMapId, action: plan.action });
}
