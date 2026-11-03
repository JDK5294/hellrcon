/**
 * Force a specific next map by collapsing the rotation down to just that map.
 *
 * This is a faithful port of the earlier bot's emergency-mapvote `_schedule_next_map`, which was
 * troubleshooted against live HLL servers. The naive "insert after current index" approach is flaky;
 * the reliable method is to reduce the rotation to a single entry (the winner) and verify it:
 *
 *   - rotation already == [winner]  → nothing to do (verified).
 *   - rotation empty                → add the winner at index 0.
 *   - otherwise                     → remove index 1 repeatedly until one entry remains, add the
 *                                     winner at index 1, remove index 0 → rotation is now [winner].
 *
 * After the mutation we re-read and REQUIRE the rotation to equal [winner], else we throw — a
 * partial rotation edit is worse than a clean failure the caller can surface.
 *
 * Game-agnostic: the caller injects how to read/add/remove rotation entries, so this works over any
 * protocol and is unit-testable with an in-memory fake.
 */

import type { PollOption } from "./vote.js";
import { resolveVoteWinner } from "./winner.js";

export interface RotationSnapshot {
  /** rotation entries, in order, by map id. */
  maps: string[];
  currentIndex: number;
}

export interface RotationIO {
  getRotation(): Promise<RotationSnapshot>;
  addMapToRotation(mapId: string, index: number): Promise<void>;
  /**
   * `mapId` is the entry standing at `index` right now, and it is not redundant: the two RCON
   * protocols address a rotation entry differently — binary-v2 removes by index, legacy text by
   * name (`rotdel <map>`). A port that carries only the index left the legacy wire with nothing to
   * name, so every removal went out as a bare `rotdel` and took nothing off the rotation.
   */
  removeMapFromRotation(index: number, mapId: string): Promise<void>;
}

export interface ScheduleResult {
  scheduledMapId: string;
  rotationMaps: string[];
  currentIndex: number;
  insertIndex: number;
  removedIndexes: number[];
  /** true when the rotation was already the single target (no mutation performed). */
  verifiedOnly: boolean;
}

/** Collapse the rotation to `mapId` and verify. Throws if the final rotation isn't exactly [mapId]. */
export async function scheduleNextMap(io: RotationIO, mapId: string): Promise<ScheduleResult> {
  const before = await io.getRotation();
  const rotationMaps = [...before.maps];
  const removedIndexes: number[] = [];

  if (rotationMaps.length === 1 && rotationMaps[0] === mapId) {
    return { scheduledMapId: mapId, rotationMaps: [mapId], currentIndex: 0, insertIndex: 0, removedIndexes: [], verifiedOnly: true };
  }

  if (rotationMaps.length === 0) {
    await io.addMapToRotation(mapId, 0);
  } else {
    // Trim everything after the first entry, then swap the survivor out for the winner. Each
    // removal names the entry standing at that index, which is the only handle the legacy wire has.
    while (rotationMaps.length > 1) {
      await io.removeMapFromRotation(1, rotationMaps[1]!);
      removedIndexes.push(1);
      rotationMaps.splice(1, 1);
    }
    await io.addMapToRotation(mapId, 1);
    // The winner now sits at 1; index 0 is still the original survivor.
    await io.removeMapFromRotation(0, rotationMaps[0]!);
    removedIndexes.push(0);
  }

  const after = await io.getRotation();
  const verifiedMaps = [...after.maps];
  if (verifiedMaps.length !== 1 || verifiedMaps[0] !== mapId) {
    throw new Error(`Rotation verification failed after scheduling ${mapId}. Expected only [${mapId}], got [${verifiedMaps.join(", ")}]`);
  }

  return {
    scheduledMapId: mapId,
    rotationMaps: verifiedMaps,
    currentIndex: after.currentIndex,
    insertIndex: removedIndexes.length ? 1 : 0,
    removedIndexes,
    verifiedOnly: false,
  };
}

/**
 * Whether the server is set to play the map in play AGAIN when this round ends.
 *
 * The vote collapses the rotation to the single map it queued, so once that map is loaded the
 * rotation names nothing else: every round the vote fails to queue a successor for replays it.
 * That is the state the vote's replay guard looks for. Every entry has to be the map in play —
 * a rotation that still names any other map moves on by itself. An unknown map in play (a
 * session that could not be read) judges nothing.
 */
export function replayQueued(rotation: Pick<RotationSnapshot, "maps">, inPlay: string | null | undefined): boolean {
  const here = inPlay?.trim().toLowerCase();
  if (!here || rotation.maps.length === 0) return false;
  return rotation.maps.every((m) => m.trim().toLowerCase() === here);
}

/**
 * What the replay guard queues, or null when the rotation is fine as it is.
 *
 * Only a rotation set to replay the map in play is touched (see `replayQueued`). A staff override
 * wins, and an override onto the map in play is a replay staff asked for, so it is left alone.
 * Otherwise the vote's current pick: the leader when there are votes, the default pick (the first
 * option of a shuffled ballot, so a random one) when there are none — never the map in play. A
 * fallback with no vote up passes the ballot it WOULD have offered, with no tallies.
 */
export function replayGuardPick(input: {
  rotation: Pick<RotationSnapshot, "maps">;
  inPlay: string | null | undefined;
  options: PollOption[];
  tallies?: number[];
  overrideMapId?: string | null;
}): string | null {
  const inPlay = input.inPlay?.trim();
  if (!inPlay || !replayQueued(input.rotation, inPlay)) return null;
  const isInPlay = (id: string) => id.trim().toLowerCase() === inPlay.toLowerCase();
  if (input.overrideMapId) return isInPlay(input.overrideMapId) ? null : input.overrideMapId;
  const w = resolveVoteWinner(input.options, input.tallies ?? [], { exclude: inPlay });
  return w && !isInPlay(w.option.id) ? w.option.id : null;
}
