/**
 * Version history for the records staff edit by hand and want to undo: rules, and the map vote's
 * map sets and schedules. Each save is kept as the record stood before and after it (see
 * ConfigVersionRow), so any save can be put back by the restore route beside the record's own.
 *
 * Only saves that change what a record DOES are kept. Switching a rule on or off, filing it under
 * a section or pausing it is not an edit anyone needs to undo from a list — the switch is right
 * there — and a history full of toggles would bury the change somebody is looking for.
 */
import type { ConfigVersionKind, MapSetRow, Repository, RuleRow, VoteScheduleRow } from "@app/db";
import { createLogger } from "@app/shared";

const log = createLogger("versions");

/** A deep copy: the in-memory store hands back its live row, which the save about to happen
 *  would rewrite underneath a snapshot that only pointed at it. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** What a rule's history keeps: what it does, its scope, its section and its own switch — never
 *  its passing state (a pause, its section's switch) or its bookkeeping. */
export function ruleSnapshot(r: RuleRow): Record<string, unknown> {
  const { id: _id, sectionOff: _so, pausedUntil: _pu, pauseReason: _pr, pausedBy: _pb, createdAt: _c, updatedAt: _u, ...rest } = r;
  return clone(rest);
}
export const mapSetSnapshot = (s: MapSetRow): Record<string, unknown> => clone({ name: s.name, game: s.game, pool: s.pool ?? {} });
export const voteScheduleSnapshot = (s: VoteScheduleRow): Record<string, unknown> => clone({ name: s.name, spec: s.spec ?? {} });

/** The parts of a rule's snapshot that are its state, not its terms: changing only these is not
 *  a save the history lists, and putting back an earlier version leaves them as they are now. */
export const RULE_STATE_KEYS: readonly string[] = ["enabled", "sectionId"];

function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, norm(val)]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Did a save change anything beyond `ignore`? */
export function snapshotChanged(before: Record<string, unknown>, after: Record<string, unknown>, ignore: readonly string[] = []): boolean {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !ignore.includes(k)));
  return stable(strip(before)) !== stable(strip(after));
}

/**
 * Keep one save. Best-effort: the save itself has already happened, and a history that could not
 * be written must not turn a good save into an error — it is logged instead.
 */
export async function recordVersion(repo: Repository, p: { user: { id: string }; name: string } | null, v: {
  kind: ConfigVersionKind; targetId: string; targetName: string | null; change: "edit" | "delete" | "restore";
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}): Promise<void> {
  await repo.configVersions.record({ ...v, actorUserId: p?.user.id ?? null, actorName: p?.name ?? null })
    .catch((err) => log.warn("version not recorded", { kind: v.kind, targetId: v.targetId, err: (err as Error).message }));
}

/** "the version from 8 Oct, 14:02 UTC" — when a restored version was saved over, for the trail. */
export function whenSaved(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}
