/**
 * Every read the worker makes of a server's session, roster or map rotation is also left for the
 * API (@app/shared live-share). The panel's Live page answers from these while they are fresh,
 * instead of opening a game connection of its own on every refresh: one staff member watching had
 * the game open a connection and log in about four times a minute, for reads the worker had just
 * made over the connections it holds anyway.
 */
import type { EventBus } from "@app/bus";
import type { StateKind } from "@app/rcon-core";
import { LIVE_ROTATION_SHARE_MS, LIVE_SHARED_KINDS, LIVE_SHARE_TTL_SEC, liveShareKey, type LiveSharedKind, type SharedLiveRead } from "@app/shared";

let shelf: Pick<EventBus, "remember"> | null = null;
/** When this worker last shared each server's read of each kind, by `${serverId}:${kind}`. */
const sharedAt = new Map<string, number>();

/** Set once at startup, like the connect helper's health repo. Null shares nothing. */
export function shareLiveReadsOn(bus: Pick<EventBus, "remember"> | null): void {
  shelf = bus;
}

const isShared = (kind: string): kind is LiveSharedKind => (LIVE_SHARED_KINDS as readonly string[]).includes(kind);

/** Leave one read of one server's live state for the API. */
export function shareLiveRead(serverId: string, kind: LiveSharedKind, value: unknown, now = Date.now()): void {
  if (!shelf) return;
  sharedAt.set(`${serverId}:${kind}`, now);
  shelf.remember(liveShareKey(serverId, kind), { at: now, value } satisfies SharedLiveRead, LIVE_SHARE_TTL_SEC);
}

/** How long ago this worker last shared the server's read of `kind` (Infinity: never). */
export function liveShareAgeMs(serverId: string, kind: LiveSharedKind, now = Date.now()): number {
  const at = sharedAt.get(`${serverId}:${kind}`);
  return at === undefined ? Infinity : now - at;
}

/** The client, its successful reads of the shared kinds also left for the API. Nothing else about a
 *  read changes: the same value comes back, and a failed read throws as it did and shares nothing. */
export function sharingLiveReads<C extends { readState(kind: StateKind): Promise<unknown> }>(client: C, serverId: string): C {
  const read = client.readState.bind(client);
  (client as { readState(kind: StateKind): Promise<unknown> }).readState = async (kind: StateKind) => {
    const value = await read(kind);
    if (isShared(kind)) shareLiveRead(serverId, kind, value);
    return value;
  };
  return client;
}

/**
 * Read the server's rotation for the panel once the last shared read of it is LIVE_ROTATION_SHARE_MS
 * old: none of the worker's loops reads it on a schedule of their own. Through the sharing client,
 * so a read that answers shares itself; one that fails shares null, which is what the page shows
 * when its own read of the rotation fails (a protocol without one, say).
 */
export async function shareRotationIfDue(client: { readState(kind: "maprotation"): Promise<unknown> }, serverId: string): Promise<void> {
  if (!shelf || liveShareAgeMs(serverId, "maprotation") < LIVE_ROTATION_SHARE_MS) return;
  await client.readState("maprotation").catch(() => shareLiveRead(serverId, "maprotation", null));
}
