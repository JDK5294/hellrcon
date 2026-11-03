"use client";
/**
 * Event report — analytics scoped to exactly one event's window. The point of the scheduler's
 * resolved boundaries: "how did Friday night go" answered over the event's real bounds (first
 * fresh round after 8 → the round running at 11 finished), not the calendar day around them.
 *
 * Live while the event is open, final once it closes. Reads GET /payout-events/:id/report.
 */
import { useEffect, useState } from "react";
import { isText, useRemembered } from "../lib/remembered";
import { api, fmt } from "../lib/api";
import { sideNameIn, useGameDescriptor } from "../lib/game";
import { useServers } from "../lib/servers";
import { EmptyState, SkeletonLines } from "./ui";
import { Panel, PanelGroup } from "./Panel";
import { Bars, StatGrid, StatTile } from "./viz";
import type { PayoutEvent } from "./Events";

interface Report {
  window: { from: string; to: string; live: boolean };
  attendance: {
    players: number; totalMinutes: number; medianMinutes: number;
    peakConcurrent: number | null; fromRoster: boolean;
    list: { playerId: string; name: string | null; minutes: number }[];
  };
  rounds: {
    id: string; seq: number; map: string | null; startedAt: string; endedAt: string | null;
    winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; durationSec: number | null;
  }[];
  top: { playerId: string; name: string | null; kills: number; deaths: number; teamkills: number }[];
}

const mins = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);

export default function EventReport() {
  const [events, setEvents] = useState<PayoutEvent[] | null>(null);
  // The event reported on, kept for the sitting; one that is no longer reportable gives way to the latest.
  const [eventId, setEventId] = useRemembered("events.report.event", "", isText, "session");
  const [report, setReport] = useState<{ event: PayoutEvent; report: Report } | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ items?: PayoutEvent[] }>("/payout-events?limit=50")
      .then((r) => {
        const reportable = (r.items ?? []).filter((ev) => ev.status === "open" || ev.status === "closed");
        setEvents(reportable);
        // The event picked earlier in the sitting, while it can still be reported on; otherwise the
        // most recent reportable one, which is almost always the one being asked about.
        setEventId((cur) => (cur && reportable.some((ev) => ev.id === cur) ? cur : reportable[0]?.id || ""));
      })
      .catch((e) => setErr(e.message));
  }, [setEventId]);

  useEffect(() => {
    // Not before the list has said which events can be reported on: the one remembered may be gone.
    if (events === null) return;
    if (!eventId) { setReport(null); setLoading(false); return; }
    // Only the event still picked fills the page: switching events quickly cannot leave the first
    // event's report landing second, under the second one's name.
    let live = true;
    setLoading(true); setErr("");
    api<{ event: PayoutEvent; report: Report }>(`/payout-events/${eventId}/report`)
      .then((got) => {
        if (!live) return;
        // An answer without its event or its report's parts (a proxy answering in the API's place)
        // is a read that failed, and said as one: drawn, it took the whole screen down.
        const r = got?.report;
        if (got?.event && r?.window && r.attendance && Array.isArray(r.rounds) && Array.isArray(r.top)) setReport(got);
        else { setReport(null); setErr("This event's report could not be read."); }
      })
      .catch((e) => { if (live) { setReport(null); setErr(e.message); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [eventId, events]);

  const r = report?.report;
  // The event's own server names the winners: one run on a Vietnam server reads US/NVA, whichever
  // server is selected.
  const { servers } = useServers();
  const eventGame = useGameDescriptor(servers.find((s) => s.id === report?.event.serverId)?.game);
  const winnerLabel = (round: Report["rounds"][number]) =>
    round.winner ? sideNameIn(eventGame, round.winner) : round.endedAt ? "—" : "in play";

  return (
    <PanelGroup viewId="event-report">
      <Panel id="event-report" title="Event report" subtitle="Attendance, rounds and standouts, over the event's exact window." caps={["events.manage", "economy.payout", "analytics.server", "analytics.match"]}>
        <div className="form-row">
          <label>Event
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events !== null && events.length === 0 && <option value="">No opened events yet</option>}
              {(events ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name} — {ev.status}</option>
              ))}
            </select>
          </label>
        </div>
        {err && <p className="error">{err}</p>}

        {events !== null && events.length === 0 && (
          <EmptyState title="Nothing to report on">A report needs an event that has opened. Schedule one — or create one over a past window and it resolves immediately.</EmptyState>
        )}
        {loading && <SkeletonLines lines={4} />}

        {r && report && (<>
          <p className="muted">
            {fmt(r.window.from)} → {fmt(r.window.to)}{r.window.live ? " (still open — numbers are live)" : ""}
            {r.attendance.fromRoster ? " · from the event's saved roster (sessions since trimmed)" : ""}
          </p>
          <StatGrid>
            <StatTile label="Players" value={r.attendance.players} accent />
            <StatTile label="Player-time" value={`${Math.round(r.attendance.totalMinutes / 60).toLocaleString()} h`} sub={`${r.attendance.totalMinutes.toLocaleString()} minutes`} />
            <StatTile label="Median stay" value={mins(r.attendance.medianMinutes)} />
            <StatTile label="Peak at once" value={r.attendance.peakConcurrent ?? "—"} />
            <StatTile label="Rounds" value={r.rounds.length} />
          </StatGrid>

          {r.attendance.list.length > 0 && (
            <Bars
              data={r.attendance.list.slice(0, 20).map((a) => ({ label: a.name ?? a.playerId.slice(0, 8), value: a.minutes, hint: `${a.name ?? a.playerId} — ${mins(a.minutes)}` }))}
              format={(n) => mins(n)}
              empty="Nobody yet."
            />
          )}

          {r.rounds.length > 0 && (
            <div className="scroll-x">
              <table className="data">
                <thead><tr><th>Map</th><th>Started</th><th>Length</th><th>Score</th><th>Winner</th></tr></thead>
                <tbody>
                  {r.rounds.map((m) => (
                    <tr key={m.id}>
                      <td>{m.map ?? "—"}</td>
                      <td>{fmt(m.startedAt)}</td>
                      <td>{m.durationSec === null ? "in play" : `${Math.round(m.durationSec / 60)} min`}</td>
                      <td>{m.alliedScore !== null && m.axisScore !== null ? `${m.alliedScore} – ${m.axisScore}` : "—"}</td>
                      <td>{winnerLabel(m)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.top.length > 0 && (<>
            <h3>Top of the board</h3>
            <div className="scroll-x">
              <table className="data">
                <thead><tr><th>Player</th><th>Kills</th><th>Deaths</th><th>Team kills</th></tr></thead>
                <tbody>
                  {r.top.map((t) => (
                    <tr key={t.playerId}>
                      <td>{t.name ?? t.playerId}</td>
                      <td>{t.kills}</td>
                      <td>{t.deaths}</td>
                      <td>{t.teamkills || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>)}
        </>)}
      </Panel>
    </PanelGroup>
  );
}
