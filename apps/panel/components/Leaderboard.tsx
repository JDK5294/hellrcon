"use client";
import { useCallback } from "react";
import { api } from "../lib/api";
import { usePagedList } from "../lib/paged";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { ActionResult, EmptyState, GoTo, Pager, ScopePicker, SkeletonRows } from "./ui";
import { SortTh, type Sortable } from "../lib/sort";
import { useServers } from "../lib/servers";
import { oneOf, useRemembered } from "../lib/remembered";
import { useScope } from "../lib/scope";

/*
 * The board ranks a career, and a career in this game is not only fragging. The sampler has been
 * collecting the game's own score buckets — combat, offense, defense, support — plus time spent
 * leading a squad, for as long as the panel has been watching, and none of it was reachable: the
 * only columns here were the four you get from a kill log, so the people who hold points, build
 * garrisons and lead squads ranked below everyone who farms kills.
 */
const SORTS = ["kills", "deaths", "teamkills", "kd", "combat", "offense", "defense", "support", "slSeconds", "playtime"] as const;
type Sort = (typeof SORTS)[number];

interface Row {
  playerId: string;
  name: string;
  kills: number;
  deaths: number;
  teamkills: number;
  kd: number;
  combat: number;
  offense: number;
  defense: number;
  support: number;
  slSeconds: number;
  playtime: number;
}

/** Seconds as the coarse duration a board wants: "12h", "1h 40m", "8m". */
function dur(sec: number): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h >= 10) return `${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/*
 * Which columns a board shows depends on what it is ranking. Showing all ten at once turns the
 * table into a spreadsheet nobody reads, so each sort brings the figures that explain it — with
 * the ranked column always present, because a board that doesn't show what it sorted by is a
 * board you have to take on trust.
 */
const SORT_LABELS: Record<Sort, string> = {
  kills: "Kills", deaths: "Deaths", teamkills: "Team kills", kd: "K/D",
  combat: "Combat score", offense: "Offense score", defense: "Defense score", support: "Support score",
  slSeconds: "Squad-leader time", playtime: "Playtime",
};
const SCORE_COLUMNS: Sort[] = ["combat", "offense", "defense", "support"];
function columnsFor(sort: Sort): Sort[] {
  if (SCORE_COLUMNS.includes(sort)) return [...SCORE_COLUMNS, "kills", "playtime"];
  if (sort === "slSeconds") return ["slSeconds", "support", "defense", "playtime", "kills"];
  if (sort === "playtime") return ["playtime", "kills", "deaths", "kd", "slSeconds"];
  return ["kills", "deaths", "kd", "teamkills", "playtime"];
}
function cell(r: Row, k: Sort): string {
  if (k === "kd") return r.kd.toFixed(2);
  if (k === "playtime") return dur(r.playtime);
  if (k === "slSeconds") return dur(r.slSeconds);
  return (r[k] ?? 0).toLocaleString();
}

export default function Leaderboard() {
  const { servers } = useServers();
  // What the board ranks by, and over which servers, kept for the sitting: opening a player from
  // the standings and coming back must find the same standings.
  const [sort, setSort] = useRemembered<Sort>("leaderboard.sort", "kills", oneOf(SORTS), "session");
  // Defaults to the pinned server, which is what the rest of the panel is showing. The board used
  // to rank every server's careers merged together while the sidebar named one of them, so two
  // populations were compared against each other and presented as one ranking.
  const [board, setScope] = useScope("leaderboard.scope");

  // The standings a page at a time, down from the top: the board showed the top fifty and nothing
  // under them. Another column or other servers are another board, and open on its first page.
  // Two quick clicks on different columns once raced, whichever board answered last being shown
  // whatever the header said; a page read for a board no longer asked for is dropped.
  const fetchPage = useCallback((offset: number, limit: number) =>
    api<{ leaderboard?: Row[]; total?: number }>(`/leaderboard?sort=${sort}${board ? `&serverId=${encodeURIComponent(board)}` : ""}&offset=${offset}&limit=${limit}`)
      .then((r) => ({ items: r.leaderboard ?? [], total: r.total ?? null })), [sort, board]);
  const list = usePagedList<Row>(fetchPage, "leaderboard.standings", board);
  const rows = list.items;
  const error = list.error;
  const rank = list.page * list.limit;

  // The standings are sorted by the API across EVERY tracked player, not just the page on screen,
  // so the column headers drive that server sort rather than re-ordering the rows we happen to
  // have. Clicking a header is the same action as the dropdown, which is why they stay in step.
  const colSort: Sortable<Row> = {
    key: sort,
    dir: "desc", // the API always returns "most first" for these columns
    toggle: (k) => setSort(k as Sort),
    sorted: (rows2) => rows2,
  };

  const cols = columnsFor(sort);

  return (
    <PanelGroup viewId="leaderboard">
      <Panel
        id="standings"
        caps="open"
        title="Leaderboard"
        actions={
          <select className="inline-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Rank by">
            <optgroup label="Combat log">
              <option value="kills">Kills</option>
              <option value="deaths">Deaths</option>
              <option value="teamkills">Team kills</option>
              <option value="kd">K/D</option>
            </optgroup>
            <optgroup label="Game score">
              <option value="combat">Combat score</option>
              <option value="offense">Offense score</option>
              <option value="defense">Defense score</option>
              <option value="support">Support score</option>
            </optgroup>
            <optgroup label="Time">
              <option value="slSeconds">Squad-leader time</option>
              <option value="playtime">Playtime</option>
            </optgroup>
          </select>
        }
      >
      <ScopePicker servers={servers} value={board} onChange={setScope} noun="Ranking" />
      <ActionResult error={error} />
      {!rows && !error && <SkeletonRows rows={8} cols={cols.length + 2} />}
      {rows && !rows.length && list.page === 0 && (
        <EmptyState icon="🏅" title="No career stats yet"
          action={<GoTo view="live">Open Live</GoTo>}>
          Standings are built as the panel watches your servers — the kill log, and the game&apos;s own
          combat, offense, defense and support scores — so they appear once people have played with
          the panel connected. To rank history from before that, import it under Administration →
          Connections → CRCON backup.
        </EmptyState>
      )}
      {rows && rows.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                {cols.map((k) => <SortTh key={k} s={colSort} k={k} numeric>{SORT_LABELS[k]}</SortTh>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.playerId}>
                  <td>{rank + i + 1}</td>
                  <td><PlayerLink playerId={r.playerId} name={r.name || "[No Name]"} /></td>
                  {cols.map((k) => <td key={k}>{cell(r, k)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && <Pager list={list} noun="player" />}
      </Panel>
    </PanelGroup>
  );
}
