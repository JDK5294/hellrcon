"use client";
/**
 * The Watched tab — the watchlist as a PLACE, under Moderation where the rest of the enforcement
 * record lives. Until now the list existed only as a card inside the VIP widget: staff who knew
 * about it found it, everyone else discovered watches one roster 👁 at a time. This is the whole
 * list, searchable across names, reasons and authors, online rows first (a watched player who is
 * HERE is the row that needs eyes), every name one click from the profile where the reasons are
 * managed. Reads GET /players/flagged — the same feed the dashboard cards use.
 */
import { useEffect, useMemo, useState } from "react";
import { isText, useRemembered } from "../lib/remembered";
import { useClientPages } from "../lib/paged";
import { api } from "../lib/api";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { ActionResult, EmptyState, Pager, SearchInput, SkeletonRows } from "./ui";
import { Time } from "./Time";
import { fileStem, type Sheet } from "../lib/download";
import { isoToWall } from "../lib/time";
import { DownloadButton } from "./Download";

interface WatchedRow {
  playerId: string;
  name: string | null;
  online: boolean;
  onlineServers: string[];
  watchBy: string | null;
  watchAt: string | null;
  reasons: { id: string; reason: string; addedBy: string | null; addedAt: string; expiresAt: string | null }[];
}

/** The watchlist as a file, row for row as on screen: every reason, who gave it, and its expiry. */
function watchSheet(rows: WatchedRow[]): Sheet {
  return {
    name: "Watched players",
    columns: [
      { key: "player", label: "Player" },
      { key: "playerId", label: "Player ID" },
      { key: "reasons", label: "Reasons" },
      { key: "watchedBy", label: "Watched by" },
      { key: "watchedSince", label: "Watched since", time: true },
      { key: "onlineNow", label: "Online now" },
    ],
    rows: rows.map((r) => [
      r.name, r.playerId,
      r.reasons.map((x) => `${x.reason} (${x.addedBy || "unknown"}${x.expiresAt ? `, until ${isoToWall(x.expiresAt).slice(0, 10)}` : ""})`).join("; ") || null,
      r.watchBy, r.watchAt, r.online ? r.onlineServers.join(", ") : null,
    ]),
  };
}

export default function Watchlist() {
  const [rows, setRows] = useState<WatchedRow[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useRemembered("watchlist.search", "", isText, "session");
  const load = () => api<{ flags: WatchedRow[] }>("/players/flagged").then((r) => setRows(r.flags)).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return rows ?? [];
    // Names, reasons AND authors: "what did we watch for teamkilling" and "everything Kreitz
    // flagged" are both questions this box should answer.
    return (rows ?? []).filter((r) =>
      (r.name ?? "").toLowerCase().includes(needle)
      || r.reasons.some((x) => x.reason.toLowerCase().includes(needle) || (x.addedBy ?? "").toLowerCase().includes(needle))
      || (r.watchBy ?? "").toLowerCase().includes(needle));
  }, [rows, needle]);
  const pages = useClientPages(rows ? filtered : null, "watchlist.list", "", needle);

  return (
    <PanelGroup viewId="moderation.watched">
      <Panel id="watched" caps="open" title="Watched players" subtitle={rows ? String(rows.length) : undefined}
        actions={<>
          <button className="ghost mini" onClick={load}>Refresh</button>
          <DownloadButton file={fileStem("watchlist")} title="Download the watchlist" count={filtered.length} noun="player"
            scope="as the list stands — its search" sheet={() => watchSheet(filtered)} />
        </>}>
        <ActionResult error={err} />
        {!rows && !err && <SkeletonRows rows={5} cols={4} />}
        {rows && rows.length === 0 && (
          <EmptyState icon="👁" title="Nobody is watched right now">
            Watching starts from any player&apos;s ⋯ menu (or their profile) — the reason typed there is
            the record this page shows. A watched player is highlighted on every roster, and the
            Discord watchlist alert pings when one connects.
          </EmptyState>
        )}
        {rows && rows.length > 0 && (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search names, reasons, staff…" />
            {filtered.length === 0 && <p className="nothing">Nothing matches &ldquo;{q}&rdquo;.</p>}
            <div className="scroll-x">
              <table>
                <thead><tr><th>Player</th><th>Why</th><th>Watched</th></tr></thead>
                <tbody>
                  {(pages.items ?? []).map((r) => (
                    <tr key={r.playerId}>
                      <td>
                        <PlayerLink playerId={r.playerId} name={<strong>{r.name ?? "unknown"}</strong>} />
                        {r.online && <div><span className="badge active" title={r.onlineServers.join(", ")}>online — {r.onlineServers.join(", ")}</span></div>}
                      </td>
                      <td>
                        {r.reasons.length === 0 && <span className="muted">no reason recorded</span>}
                        {r.reasons.map((x) => (
                          <div key={x.id}>
                            {x.reason}
                            <span className="muted fs-xs"> — {x.addedBy || "unknown"}{x.expiresAt ? <> · expires <Time iso={x.expiresAt} /></> : null}</span>
                          </div>
                        ))}
                      </td>
                      <td>{r.watchAt ? <Time iso={r.watchAt} /> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > 0 && <Pager list={pages} noun="player" />}
          </>
        )}
      </Panel>
    </PanelGroup>
  );
}
