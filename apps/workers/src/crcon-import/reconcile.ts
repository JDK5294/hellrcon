/**
 * Import reconciliation: count both databases and prove they agree.
 *
 * An import that "finished" is not an import that is correct. This counts what CRCON's own
 * database holds for one server, counts what our database holds for the matching server, and
 * compares them category by category. Every line either matches exactly or names its own
 * difference — there is no "looks about right".
 *
 * The comparison is only honest if both sides are counted under the SAME rules the import runs
 * by, so the source counts apply them too:
 *   - only this server's rows (log_lines.server / map_history.server_number)
 *   - only the imported era, i.e. strictly before the overlap cutoff — from the cutoff on, the
 *     live tracker owns the record and the import deliberately skips it
 *   - only action families we have a stage for; anything else is reported as unmapped rather
 *     than quietly widening the expected count
 *
 * A category that is expected-to-differ is stated as such with its reason, so the report's green
 * lines mean "verified equal" and never "not checked".
 */
import type { Repository } from "@app/db";
import { iso, logDataType, type SqlClient } from "./from-database.js";

/** How each archive log dataType lands in our event table. Several map onto the same kind — the
 *  admin log and the auto-TK log both produce kicks and bans — so expectations are summed, never
 *  compared one-to-one. */
const DATATYPE_TO_KINDS: Record<string, string[]> = {
  log_kill: ["evt.kill"],
  log_teamkill: ["evt.teamkill"],
  log_connect: ["evt.player.connected"],
  log_disconnect: ["evt.player.disconnected"],
  log_teamswitch: ["evt.player.teamSwitched"],
  // Verified against the transform, not assumed: chat collapses to exactly two kinds
  // (a [unit]/[squad] scope becomes .squad, everything else .team).
  log_chat: ["evt.chat.team", "evt.chat.squad"],
  log_camera: ["evt.admin.camera"],
  log_message: ["evt.admin.message"],
  log_match: ["evt.match.started", "evt.match.ended"],
  log_vote: ["evt.vote.started", "evt.vote.completed", "evt.vote.cast"],
  log_admin: ["evt.player.kicked", "evt.player.banned"],
  log_tkauto: ["evt.player.kicked", "evt.player.banned"],
};

export interface ReconcileLine {
  category: string;
  source: number;
  destination: number;
  delta: number;
  ok: boolean;
  /** Set when a difference is expected and legitimate — states why, so it is never mistaken for a
   *  clean match or for a fault. */
  note?: string;
}

export interface ReconcileReport {
  serverNumber: number;
  cutoff: string | null;
  /**
   * THE COVERAGE SEAM — the gap class that hides between systems rather than inside one. If
   * CRCON's last recorded log line predates our overlap cutoff, the window between them was
   * recorded by NEITHER system: CRCON had already stopped when the panel started watching.
   * That data does not exist anywhere and no import can recover it — but it must be REPORTED,
   * because a career that looks slightly light is otherwise blamed on the import.
   * Null when the source's record reaches the cutoff (or nothing sets a cutoff yet).
   */
  seam: { sourceLastLog: string | null; cutoff: string; uncoveredHours: number } | null;
  lines: ReconcileLine[];
  /** Log rows in an action family no stage claims. Non-zero means CRCON emitted something we do
   *  not import — it must be explained before an import is called complete. */
  unmappedLogRows: { type: string; count: number }[];
  /** True only when every checked category agrees and nothing is unmapped. */
  complete: boolean;
}

/** Count the source rows that SHOULD have landed: this server's, before the cutoff, in a family
 *  we import. Anything else is either out of scope or reported as unmapped. */
async function sourceCounts(
  crcon: SqlClient, serverNumber: number, cutoff: string | null,
): Promise<{ byDataType: Record<string, number>; unmapped: { type: string; count: number }[]; rounds: number; scoreboardLines: number; sessions: number; sourceLastLog: string | null }> {
  const cutoffClause = cutoff ? " AND event_time < $2" : "";
  const args: unknown[] = cutoff ? [String(serverNumber), cutoff] : [String(serverNumber)];
  const { rows } = await crcon.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM log_lines WHERE server = $1::text${cutoffClause} GROUP BY type`,
    args,
  );
  // ::text + iso(): CRCON's naive timestamps mean UTC, and the driver must never get the chance
  // to parse them in the host's zone (see iso()'s doc in from-database.ts).
  const last = await crcon.query<{ t: string | null }>(
    "SELECT max(event_time)::text AS t FROM log_lines WHERE server = $1::text", [String(serverNumber)],
  );
  const sourceLastLog = iso(last.rows[0]?.t ?? null);
  const byDataType: Record<string, number> = {};
  const unmapped: { type: string; count: number }[] = [];
  for (const r of rows) {
    const dt = logDataType(r.type);
    if (!dt) { unmapped.push({ type: r.type ?? "(null)", count: r.n }); continue; }
    byDataType[dt] = (byDataType[dt] ?? 0) + r.n;
  }

  const roundArgs: unknown[] = cutoff ? [serverNumber, cutoff] : [serverNumber];
  const roundCutoff = cutoff ? " AND start < $2" : "";
  // A round with no end is never imported (a torn snapshot must not open a round here), so the
  // source count excludes them too — otherwise every unfinished round would read as a loss.
  const rounds = await crcon.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM map_history WHERE server_number = $1 AND "end" IS NOT NULL${roundCutoff}`, roundArgs,
  );
  const sb = await crcon.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM player_stats ps JOIN map_history m ON m.id = ps.map_id
      WHERE m.server_number = $1 AND m."end" IS NOT NULL${cutoff ? " AND m.start < $2" : ""}`, roundArgs,
  );
  const sessions = await crcon.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM player_sessions WHERE server_number = $1${cutoff ? ' AND start < $2' : ""}`, roundArgs,
  );
  return {
    byDataType, unmapped, sourceLastLog,
    rounds: rounds.rows[0]?.n ?? 0,
    scoreboardLines: sb.rows[0]?.n ?? 0,
    sessions: sessions.rows[0]?.n ?? 0,
  };
}

/**
 * Reconcile one server's import against the CRCON database it came from.
 *
 * `crcon` reads the source install; `repo` is our own store; `serverId` is our server and
 * `serverNumber` is CRCON's. Read-only on both sides — safe to run as often as you like.
 */
export async function reconcile(
  crcon: SqlClient, repo: Repository, serverId: string, serverNumber: number,
): Promise<ReconcileReport> {
  const dest = await repo.crconSnapshot.importedBreakdown(serverId);
  const src = await sourceCounts(crcon, serverNumber, dest.cutoff);
  const lines: ReconcileLine[] = [];
  const add = (category: string, source: number, destination: number, note?: string) => {
    const delta = destination - source;
    lines.push({ category, source, destination, delta, ok: note ? true : delta === 0, ...(note ? { note } : {}) });
  };

  // Events, per log family. Families that share a destination kind are summed on both sides so
  // the comparison stays meaningful (admin + auto-TK both produce kicks and bans).
  const grouped = new Map<string, { dataTypes: string[]; kinds: string[] }>();
  for (const [dt, kinds] of Object.entries(DATATYPE_TO_KINDS)) {
    const key = kinds.join("+");
    const cur = grouped.get(key) ?? { dataTypes: [], kinds };
    cur.dataTypes.push(dt);
    grouped.set(key, cur);
  }
  for (const [, g] of grouped) {
    const source = g.dataTypes.reduce((a, dt) => a + (src.byDataType[dt] ?? 0), 0);
    const destination = g.kinds.reduce((a, k) => a + (dest.eventsByKind[k] ?? 0), 0);
    add(g.dataTypes.join(" + "), source, destination);
  }

  add("rounds", src.rounds, dest.matches);
  // Per-player round lines also grow from kill attribution (every kill credits its round for the
  // actor AND the victim), so ours legitimately exceeds CRCON's scoreboard rows. A SHORTFALL,
  // though, means scoreboard lines failed to land — that one still fails hard.
  const sbNote = dest.matchStats >= src.scoreboardLines
    ? "ours also builds round lines from kill attribution, so a surplus is expected"
    : undefined;
  add("scoreboard lines", src.scoreboardLines, dest.matchStats, sbNote);
  // Sessions have two sources on our side — CRCON's own session rows AND pairs rebuilt from the
  // connect/disconnect log — so ours legitimately EXCEEDS theirs. Only a shortfall is a fault.
  const sessionNote = dest.sessions >= src.sessions
    ? "ours also rebuilds sessions from connect/disconnect pairs, so a surplus is expected"
    : undefined;
  add("sessions", src.sessions, dest.sessions, sessionNote);

  // Moderation events lifted from player profiles. They have no log-line counterpart, so there is
  // nothing to equate them to — reported so every imported event is accounted for somewhere.
  add("profile moderation events", dest.profileActionEvents, dest.profileActionEvents,
      "from player profiles (received_actions), not the game log — no source row to compare");

  // The seam: only meaningful when a cutoff exists AND the source stopped recording before it.
  // An hour of slack absorbs clock skew and the handful of minutes a normal cutover takes.
  let seam: ReconcileReport["seam"] = null;
  if (dest.cutoff) {
    const lastT = src.sourceLastLog ? Date.parse(src.sourceLastLog) : NaN;
    const cutT = Date.parse(dest.cutoff);
    const uncoveredHours = Number.isFinite(lastT) ? (cutT - lastT) / 3_600_000 : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(lastT) || uncoveredHours > 1) {
      seam = { sourceLastLog: src.sourceLastLog, cutoff: dest.cutoff, uncoveredHours: Math.round(uncoveredHours * 10) / 10 };
    }
  }

  const complete = lines.every((l) => l.ok) && src.unmapped.length === 0;
  return { serverNumber, cutoff: dest.cutoff, seam, lines, unmappedLogRows: src.unmapped, complete };
}

/** The report as a plain-text table — what a human reads to decide the import is done. */
export function formatReport(r: ReconcileReport): string {
  const out: string[] = [];
  out.push(`CRCON server ${r.serverNumber} — ${r.complete ? "COMPLETE" : "INCOMPLETE"}`);
  out.push(`imported era: everything before ${r.cutoff ?? "(no local events yet — the whole history)"}`);
  out.push("");
  const w = Math.max(...r.lines.map((l) => l.category.length), 20);
  for (const l of r.lines) {
    const mark = l.ok ? "ok  " : "FAIL";
    const delta = l.delta === 0 ? "" : ` (${l.delta > 0 ? "+" : ""}${l.delta})`;
    out.push(`${mark} ${l.category.padEnd(w)} source ${String(l.source).padStart(9)}  ours ${String(l.destination).padStart(9)}${delta}${l.note ? `  — ${l.note}` : ""}`);
  }
  if (r.seam) {
    out.push("");
    out.push(`WARN coverage seam: CRCON's record for this server ends at ${r.seam.sourceLastLog ?? "(no log lines at all)"} but local`);
    out.push(`     tracking only began at ${r.seam.cutoff} — the ${Number.isFinite(r.seam.uncoveredHours) ? `${r.seam.uncoveredHours}h` : "entire"} window between them was recorded`);
    out.push("     by NEITHER system. Nothing played in that window can be imported from anywhere; careers are");
    out.push("     correspondingly light through no fault of the import.");
  }
  if (r.unmappedLogRows.length) {
    out.push("");
    out.push("Log rows in families no stage imports:");
    for (const u of r.unmappedLogRows) out.push(`  ${u.type}: ${u.count}`);
  }
  return out.join("\n");
}
