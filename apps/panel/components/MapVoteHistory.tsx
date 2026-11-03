"use client";
/**
 * Map vote history — what was voted on, how it went, and who turned up.
 *
 * This is the reading surface for votes; the map-vote SETTINGS live under Automation → Map vote.
 * Keeping them apart is deliberate: judging whether your map set is working is a different job from
 * configuring it, done at a different time, often by different people.
 *
 * Three questions, in the order people ask them:
 *   1. What has been played lately, and was it what players wanted?
 *   2. Which maps actually win, and which just sit in the list?
 *   3. Who is doing the voting?
 *
 * Anyone who can read the map-vote config sees the ballot: reading a vote and reading who cast it
 * are the same job, and the votes are public in the Discord channel anyway. Votes recorded before
 * we captured voters simply have no names, and the panel says so rather than looking broken.
 */
import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import { usePagedList, useClientPages } from "../lib/paged";
import { useSortable, SortTh } from "../lib/sort";
import { useServers } from "../lib/servers";
import { isTextOrNull, useRemembered } from "../lib/remembered";
import { PanelGroup, Panel } from "./Panel";
import { StatGrid, StatTile, BreakdownBars } from "./viz";
import { PlayerLink } from "./PlayerLink";
import { Time } from "./Time";
import { ActionResult, Nothing, NoServersPage, Pager, SkeletonRows, Explanation } from "./ui";

interface Voter { discordId: string; name: string }
interface Option { id: string; name: string; votes: number; voters?: Voter[] }
interface HistoryRow {
  id: string; decidedAt: string; profile: string | null;
  options: Option[]; winnerId: string | null; winnerName: string | null;
  totalVotes: number; outcome: string; applied: boolean;
}
interface TallyRow { mapId: string; name: string; offered: number; won: number; votes: number }
interface VoterRow {
  discordUserId: string; discordName: string; votes: number; wins: number; lastVotedAt: string;
  userId: string | null; playerId: string | null; playerName: string | null;
  /** Cast in game (chat-number voting) by someone with no linked Discord. */
  ingame?: boolean;
}

/** Plain-words explanation of each recorded outcome — no codes for staff to decode. */
const OUTCOME_LABEL: Record<string, string> = {
  vote: "players decided",
  override: "staff forced the map",
  skipped: "staff skipped the vote",
  no_votes: "nobody voted — default pick",
  restarted: "staff started a new vote",
  held: "staff changed the map by hand — result not applied",
  error: "something went wrong",
};

interface Summary { rounds: number; decided: number; forced: number; silent: number; totalVotes: number; contested: number }

export default function MapVoteHistory() {
  const { serverId, servers } = useServers();
  // The round opened and the page it is on, kept for the sitting.
  const [expanded, setExpanded] = useRemembered<string | null>("mapvotes.expanded", null, isTextOrNull, "session");
  // Tally, voters and the headline summary describe the WHOLE record whatever page the rounds
  // table is on; the API sends them alongside every page and they are identical across pages,
  // so the freshest copy is simply kept.
  const [aux, setAux] = useState<{ tally: TallyRow[]; voters: VoterRow[]; summary: Summary | null }>({ tally: [], voters: [], summary: null });

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      api<{ history: HistoryRow[]; total?: number; tally: TallyRow[]; voters: VoterRow[]; summary?: Summary }>(
        `/servers/${serverId}/mapvote/history?limit=${limit}&offset=${offset}`,
      ).then((r) => {
        setAux({ tally: r.tally ?? [], voters: r.voters ?? [], summary: r.summary ?? null });
        return { items: r.history, total: r.total ?? null };
      }),
    [serverId],
  );
  const rounds = usePagedList<HistoryRow>(serverId ? fetchPage : null, "mapvotes", serverId);
  const { items: history, error: err, reload: load } = rounds;
  const tally = aux.tally;
  const voters = aux.voters;

  // Headline numbers over everything recorded — served by the API so they cover every vote, not
  // the page on screen. An older API without them falls back to the page (better than nothing).
  const summary = useMemo(() => {
    const s = aux.summary ?? {
      rounds: history?.length ?? 0,
      decided: (history ?? []).filter((x) => x.outcome === "vote").length,
      forced: (history ?? []).filter((x) => x.outcome === "override").length,
      silent: (history ?? []).filter((x) => x.outcome === "no_votes").length,
      totalVotes: (history ?? []).reduce((n, x) => n + x.totalVotes, 0),
      contested: (history ?? []).filter((x) => x.totalVotes > 0).length,
    };
    return { ...s, avg: s.contested ? Math.round((s.totalVotes / s.contested) * 10) / 10 : 0 };
  }, [aux.summary, history]);

  const tallySort = useSortable<TallyRow>({
    map: (t) => t.name, offered: (t) => t.offered, won: (t) => t.won,
    rate: (t) => (t.offered ? t.won / t.offered : null), votes: (t) => t.votes,
  }, "won", "desc", "mapvote-tally");
  const sortedTally = useMemo(() => tallySort.sorted(tally), [tallySort, tally]);
  // The tables wait for the first page of rounds, which brings them: their empty start would read as
  // a short list and send the pages left back to the first.
  const tallyPages = useClientPages(history ? sortedTally : null, "mapvotes.tally", serverId, `${tallySort.key}:${tallySort.dir}`);

  const voterSort = useSortable<VoterRow>({
    who: (v) => v.discordName, player: (v) => v.playerName ?? "", votes: (v) => v.votes,
    wins: (v) => v.wins, last: (v) => v.lastVotedAt,
  }, "votes", "desc", "mapvote-voters");
  const sortedVoters = useMemo(() => voterSort.sorted(voters), [voterSort, voters]);
  const voterPages = useClientPages(history ? sortedVoters : null, "mapvotes.voters", serverId, `${voterSort.key}:${voterSort.dir}`);

  if (!servers.length) return <NoServersPage>Map votes are held on a server at the end of a round, so this fills in once one is connected.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to see its map vote history.</p></div>;

  return (
    <PanelGroup viewId="mapvote-history">
      <Panel
        id="summary"
        caps="open" title="Map votes at a glance" subtitle="every vote we have a record of"
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}
      >
        <ActionResult error={err} />
        {!history && !err && <SkeletonRows rows={5} cols={4} />}
        {history && history.length === 0 && (
          <p className="muted notice">
            No votes recorded yet. The first one appears here once a match ends with the map vote turned on
            (Automation → Map vote).
          </p>
        )}
        {history && history.length > 0 && (
          <>
            <StatGrid>
              <StatTile label="Votes held" value={summary.rounds.toLocaleString()} accent />
              <StatTile label="Decided by players" value={summary.decided.toLocaleString()} sub={`${Math.round((summary.decided / summary.rounds) * 100)}% of votes`} />
              <StatTile label="Forced by staff" value={summary.forced.toLocaleString()} sub={summary.forced ? "override was set" : "none"} />
              <StatTile label="Nobody voted" value={summary.silent.toLocaleString()} sub={summary.silent ? "default pick used" : "never happened"} />
              <StatTile label="Votes cast" value={summary.totalVotes.toLocaleString()} sub={`${summary.avg} per vote on average`} />
            </StatGrid>
            {summary.silent > summary.rounds / 3 && (
              <p className="hint mb-0 notice">
                A third or more of your votes get no votes at all. Players probably aren&apos;t seeing them —
                try adding an in-game reminder under Automation → Map vote, step 7.
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel id="rounds" caps="open" title="Every vote" subtitle="newest first — open one to see how it broke down">
        {history && history.length > 0 && (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th><th>Map played</th>
                  <th className="num">Votes</th>
                  <th>How it was decided</th><th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const open = expanded === h.id;
                  const top = Math.max(1, ...h.options.map((o) => o.votes));
                  return (
                    <>
                      <tr key={h.id}>
                        <td className="hint"><Time iso={h.decidedAt} /></td>
                        <td>{h.winnerName ?? h.winnerId ?? "—"}</td>
                        <td className="num">{h.totalVotes}</td>
                        <td className="hint">
                          {OUTCOME_LABEL[h.outcome] ?? h.outcome}
                          {h.winnerId && !h.applied ? " (not applied — observe mode)" : ""}
                          {h.profile ? ` · ${h.profile}` : ""}
                        </td>
                        <td className="num">
                          {h.options.length > 0 && (
                            <button className="ghost mini" onClick={() => setExpanded(open ? null : h.id)}>
                              {open ? "Hide" : "Show"} the {h.options.length} maps
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${h.id}-detail`}>
                          <td colSpan={5}>
                            {h.options.map((o) => (
                              <div key={o.id} style={{ marginBottom: 8 }}>
                                <div className="row" style={{ alignItems: "center", gap: 10 }}>
                                  <span style={{ flex: "0 0 38%", fontSize: "0.88rem" }}>
                                    {o.id === h.winnerId ? "🏆 " : ""}{o.name}
                                  </span>
                                  <span className="breakdown-track grow">
                                    <span className="breakdown-fill" style={{ width: `${Math.round((o.votes / top) * 100)}%` }} />
                                  </span>
                                  <span className="hint" style={{ flex: "0 0 70px", textAlign: "right" }}>
                                    {o.votes} vote{o.votes === 1 ? "" : "s"}
                                  </span>
                                </div>
                                {o.voters && o.voters.length > 0 && (
                                  <p className="hint" style={{ margin: "2px 0 0 4px" }}>
                                    {o.voters.map((v) => v.name).join(", ")}
                                  </p>
                                )}
                              </div>
                            ))}
                            {h.options.every((o) => !o.voters) && (
                              <p className="hint mb-0">
                                This vote was recorded before we started keeping track of who voted, so only the totals exist.
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager list={rounds} noun="vote" />
      </Panel>

      <Panel id="maps" caps="open" title="Which maps win" subtitle="how often each one is offered, and how often it gets picked">
        {tally.length === 0
          ? <Nothing>Nothing recorded yet.</Nothing>
          : (
            <>
              <BreakdownBars data={tally.slice(0, 12).map((t) => ({ key: t.mapId, label: t.name, value: t.won }))} empty="No map has won a vote yet." />
              <p className="hint" style={{ marginTop: 10, marginBottom: 4 }}>
                A map offered often that never wins is one your players don&apos;t want — that&apos;s the case for taking it out of the set.
              </p>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <SortTh s={tallySort} k="map">Map</SortTh>
                      <SortTh s={tallySort} k="offered" numeric>Offered</SortTh>
                      <SortTh s={tallySort} k="won" numeric>Won</SortTh>
                      <SortTh s={tallySort} k="rate" numeric>Win rate</SortTh>
                      <SortTh s={tallySort} k="votes" numeric>Votes</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {(tallyPages.items ?? []).map((t) => (
                      <tr key={t.mapId}>
                        <td>{t.name}</td>
                        <td className="num">{t.offered}</td>
                        <td className="num">{t.won}</td>
                        <td className="num hint">{t.offered ? `${Math.round((t.won / t.offered) * 100)}%` : "—"}</td>
                        <td className="num">{t.votes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager list={tallyPages} noun="map" />
            </>
          )}
      </Panel>

      <Panel id="voters" caps="open" title="Who votes" subtitle="the people turning up to decide your rotation">
          {voters.length === 0 ? (
            <p className="muted">
              No ballots recorded yet. Discord tells us who voted when a vote ends, so this fills in from the next
              vote onwards.
            </p>
          ) : (
            <>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <SortTh s={voterSort} k="who">Who</SortTh>
                      <SortTh s={voterSort} k="player">Player</SortTh>
                      <SortTh s={voterSort} k="votes" numeric>Votes</SortTh>
                      <SortTh s={voterSort} k="wins" numeric>Got their map</SortTh>
                      <SortTh s={voterSort} k="last">Last voted</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {(voterPages.items ?? []).map((v) => (
                      <tr key={v.discordUserId}>
                        <td>{v.discordName}</td>
                        <td>
                          {/* An in-game voter IS a game account — one with no Discord — so the
                              Discord-link prompt below is not their problem and must not be
                              aimed at them. */}
                          {v.playerId
                            ? <PlayerLink playerId={v.playerId} name={v.playerName ?? "view player"} />
                            : <span className="hint">{v.ingame ? "voted in game — no game account matched" : "not linked to a game account"}</span>}
                        </td>
                        <td className="num">{v.votes}</td>
                        <td className="num hint">
                          {v.wins} ({v.votes ? Math.round((v.wins / v.votes) * 100) : 0}%)
                        </td>
                        <td className="hint"><Time iso={v.lastVotedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager list={voterPages} noun="voter" />
              <Explanation>
                Link a Discord account to a game account on the player&apos;s profile to see that person&apos;s
                voting history alongside the rest of their record.
              </Explanation>
            </>
          )}
      </Panel>
    </PanelGroup>
  );
}
