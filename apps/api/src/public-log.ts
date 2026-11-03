/**
 * The public stats page's GAME LOG for one round: what happened, in order. The round's start and
 * end, every kill and team kill with its weapon, every connect and disconnect, every team switch,
 * and every time an admin went into the admin camera or came out of it.
 *
 * Built from the event store the ingest fills anyway. Events carry no round id, so a round is its
 * time window on its server, the same window the round report reads. Names only, like everything
 * public: the stored rows carry internal ids beside the names, and none of them is copied here.
 * No chat (what players say is not a stat), and of moderation only the admin camera, shown so
 * players can see who watched and when: who went in or out, never the line's own words.
 */
import type { EvtRow } from "@app/db";

/** What the log carries. The round's start and end come from the round itself, not from these. */
export const PUBLIC_LOG_KINDS: readonly string[] = [
  "evt.kill", "evt.teamkill", "evt.player.connected", "evt.player.disconnected", "evt.player.teamSwitched",
  "evt.admin.camera",
];
/** The most lines one round's log reads; a round with more says it was cut, never silently. */
export const PUBLIC_LOG_LIMIT = 20_000;

export interface PublicLogLine {
  /** Seconds since the round began. */
  t: number;
  /** The stored kind; the round's start and end are evt.match.started / evt.match.ended. */
  kind: string;
  who?: string;
  whom?: string;
  weapon?: string;
  /** A team switch's teams, as the game named them, and the side swap the ingest worked out. */
  from?: string;
  to?: string;
  swapFrom?: string;
  swapCount?: number;
  /** An admin camera line: true when the admin went in, false when they came out. */
  entered?: boolean;
}

export interface PublicLog {
  start: string;
  end: string | null;
  /** True when the round had more lines than PUBLIC_LOG_LIMIT and the log is not all of it. */
  truncated: boolean;
  lines: PublicLogLine[];
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One round's log from its window's events (any order), between its start and end lines. */
export function publicMatchLog(events: readonly EvtRow[], startedAt: string, endedAt: string | null, truncated: boolean): PublicLog {
  const startMs = Date.parse(startedAt);
  const secs = (iso: string) => Math.max(0, Math.round((Date.parse(iso) - startMs) / 1000));
  const lines: PublicLogLine[] = [{ t: 0, kind: "evt.match.started" }];
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (!PUBLIC_LOG_KINDS.includes(e.kind)) continue;
    // Which way the admin went is the parser's word (`entered`); a camera line that says neither
    // is left out rather than shown as one or the other.
    const entered = e.kind === "evt.admin.camera" ? e.data?.entered : undefined;
    if (e.kind === "evt.admin.camera" && typeof entered !== "boolean") continue;
    const line: PublicLogLine = { t: secs(e.ts), kind: e.kind, who: text(e.actorName) ?? "?" };
    if (typeof entered === "boolean") line.entered = entered;
    if (e.kind === "evt.kill" || e.kind === "evt.teamkill") {
      line.whom = text(e.victimName) ?? "?";
      const weapon = text(e.weapon);
      if (weapon) line.weapon = weapon;
    } else if (e.kind === "evt.player.teamSwitched") {
      const d = e.data ?? {};
      for (const k of ["from", "to", "swapFrom"] as const) {
        const v = text(d[k]);
        if (v) line[k] = v;
      }
      if (typeof d.swapCount === "number" && Number.isFinite(d.swapCount)) line.swapCount = d.swapCount;
    }
    lines.push(line);
  }
  if (endedAt) lines.push({ t: secs(endedAt), kind: "evt.match.ended" });
  return { start: startedAt, end: endedAt, truncated, lines };
}
