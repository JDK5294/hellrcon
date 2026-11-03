"use client";
/**
 * Match history — the match start/end events paired into rounds (map, when, duration, result). Reads
 * GET /servers/:id/matches (server-side pairing). A round still in progress shows as ongoing. This
 * surfaces the match events the ingest already captures.
 */
import { useCallback } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { useAppNav } from "../lib/nav";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, EmptyState, NoServersPage, Pager, SkeletonRows } from "./ui";
import { useSortable, SortTh } from "../lib/sort";
import { Time } from "./Time";
import { usePagedList } from "../lib/paged";

interface Match { id?: string; map: string | null; startedAt: string; endedAt: string | null; durationSec: number | null; result: string | null; score: string | null }

function duration(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One page of rounds; older ones load on demand. */

export default function Matches() {
  const { serverId, servers } = useServers();
  const nav = useAppNav();
  const fetchPage = useCallback(
    // The anchor pins later pages to the moment page one was read, so a round ending mid-read
    // cannot shift every page below it.
    (offset: number, limit: number, cursor?: string) => api<{ matches: Match[]; total?: number; anchor?: string }>(
      `/servers/${serverId}/matches?limit=${limit}&offset=${offset}${cursor ? `&anchor=${encodeURIComponent(cursor)}` : ""}`,
    ).then((r) => ({ items: r.matches, total: r.total ?? null, cursor: r.anchor })),
    [serverId],
  );
  // The page is kept for the sitting, with the server it is on: a round opened from it comes back
  // to the same page.
  const rounds = usePagedList<Match>(serverId ? fetchPage : null, "matches", serverId);
  const { items: matches, error: err, reload: load } = rounds;

  const sort = useSortable<Match>({
    map: (m) => m.map ?? "",
    started: (m) => m.startedAt,
    duration: (m) => m.durationSec ?? 0,
    result: (m) => m.result ?? "",
  }, "started", "desc", "matches");

  if (!servers.length) return <NoServersPage>Rounds are recorded as the panel watches a server play through them.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to view its match history.</p></div>;

  return (
    <PanelGroup viewId="matches">
      <Panel
        id="history"
        caps="open"
        title="Match history"
        subtitle="rounds played, from the game log"
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}
      >
      <ActionResult error={err} />
      {!matches && !err && <SkeletonRows rows={6} cols={5} />}
      {matches && matches.length === 0 && (
        <EmptyState icon="🗺" title="No rounds recorded yet">
          A round is recorded when the panel sees a match start and end on a connected server, so the first
          entries appear after the next map change. Older rounds can be brought in with the CRCON import
          under Administration → Connections.
        </EmptyState>
      )}
      {matches && matches.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr>
              <SortTh s={sort} k="map">Map</SortTh>
              <SortTh s={sort} k="started">Started</SortTh>
              <SortTh s={sort} k="duration" numeric>Duration</SortTh>
              <SortTh s={sort} k="result">Result</SortTh>
            </tr></thead>
            <tbody>
              {sort.sorted(matches).map((m, i) => (
                // A round with a durable record opens its scoreboard; a legacy row paired from the
                // event window has no id, so it stays a plain row rather than a link that 404s.
                <tr key={m.id ?? `${m.startedAt}-${i}`}
                    className={m.id ? "row-link" : undefined}
                    onClick={m.id ? () => nav.go("match", { matchId: m.id }) : undefined}>
                  <td><strong>{m.map ?? "—"}</strong></td>
                  <td><Time iso={m.startedAt} /></td>
                  <td>{m.endedAt ? duration(m.durationSec) : <span className="badge active">in progress</span>}</td>
                  <td>{m.score ? m.score : m.result ? <span className="muted">{m.result}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager list={rounds} noun="round" />
      </Panel>
    </PanelGroup>
  );
}
