"use client";
/**
 * What this player votes for. Fetched on its own (GET /players/:id/mapvote) rather than folded into
 * the profile payload, because it only exists for players with a linked Discord account and the
 * profile is already a heavy read.
 *
 * The panel earns its space by answering something the rest of the profile can't: whether this
 * person actually shows up to decide the rotation, and which maps they keep asking for. It renders
 * nothing at all when there is no link and nothing recorded — an empty shell on every profile would
 * be worse than no panel.
 */
import { useEffect, useMemo, useState } from "react";
import { fmtDay } from "../lib/time";
import { api } from "../lib/api";
import { useClientPages } from "../lib/paged";
import { useSortable, SortTh } from "../lib/sort";
import { Panel } from "./Panel";
import { Time } from "./Time";
import { Pager, SkeletonRows } from "./ui";
import { StatGrid, StatTile, BreakdownBars } from "./viz";

interface Preference { mapId: string; name: string; votes: number; wins: number; lastVotedAt: string }
interface Ballot { id: string; decidedAt: string; mapId: string; mapName: string; won: boolean }
interface Resp {
  linked: boolean;
  discordId: string | null;
  totals: { votes: number; wins: number; firstVotedAt: string | null; lastVotedAt: string | null };
  preferences: Preference[];
  ballots: Ballot[];
}

export function PlayerMapVotes({ playerId }: { playerId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Voting history is an extra, not part of the profile — a failure here (no permission, nothing
    // recorded) simply means no panel.
    api<Resp>(`/players/${playerId}/mapvote`)
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [playerId]);

  const sort = useSortable<Ballot>({
    when: (b) => b.decidedAt, map: (b) => b.mapName, outcome: (b) => b.won,
  }, "when", "desc", "player-ballots");
  const sorted = useMemo(() => sort.sorted(data?.ballots ?? []), [sort, data]);
  const pages = useClientPages(data ? sorted : null, `players.profile.${playerId}.mapVotes`, "", `${sort.key}:${sort.dir}`); // nothing until loaded, like the VIP history

  // The profile renders many panels at once; while this one is still finding out whether it even
  // applies, it holds its place the same way every sibling panel does.
  if (loading) {
    return (
      <Panel id="mapvotes" caps="mapvote.config" title="Map votes" subtitle="checking for a linked Discord account…">
        <SkeletonRows rows={3} cols={3} />
      </Panel>
    );
  }
  if (!data) return null;
  // Not linked and never voted → nothing worth a panel. Linked with no votes yet DOES get a panel,
  // because "we can see their votes, there just aren't any" is useful information.
  if (!data.linked) return null;
  if (data.totals.votes === 0) {
    return (
      <Panel id="mapvotes" caps="mapvote.config" title="Map votes" subtitle="their Discord account is linked">
        <p className="muted">
          No map votes recorded for this player yet. Their votes will appear here once they take part in one.
        </p>
      </Panel>
    );
  }

  const { totals, preferences } = data;
  const winRate = Math.round((totals.wins / totals.votes) * 100);
  const favourite = preferences[0];

  return (
    <Panel id="mapvotes" caps="mapvote.config" title="Map votes" subtitle="what they vote for, and how often they get it">
      <StatGrid>
        <StatTile label="Votes cast" value={totals.votes.toLocaleString()} accent
          sub={totals.firstVotedAt ? `since ${fmtDay(totals.firstVotedAt)}` : undefined} />
        <StatTile label="Got the map they picked" value={`${totals.wins} (${winRate}%)`}
          sub={winRate >= 50 ? "usually on the winning side" : "often outvoted"} />
        <StatTile label="Favourite map" value={favourite ? favourite.name : "—"}
          sub={favourite ? `voted for ${favourite.votes} time${favourite.votes === 1 ? "" : "s"}` : undefined} />
        <StatTile label="Last voted" value={totals.lastVotedAt ? fmtDay(totals.lastVotedAt) : "—"} />
      </StatGrid>

      {preferences.length > 0 && (
        <>
          <p className="hint" style={{ marginTop: 12, marginBottom: 4 }}><strong>Maps they ask for</strong></p>
          <BreakdownBars
            data={preferences.slice(0, 10).map((p) => ({ key: p.mapId, label: p.name, value: p.votes }))}
            empty="No preferences recorded yet."
          />
        </>
      )}

      {(pages.items?.length ?? 0) > 0 && (
        <>
          <p className="hint" style={{ marginTop: 12, marginBottom: 4 }}><strong>Every vote they cast</strong></p>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <SortTh s={sort} k="when">When</SortTh>
                  <SortTh s={sort} k="map">Voted for</SortTh>
                  <SortTh s={sort} k="outcome">Outcome</SortTh>
                </tr>
              </thead>
              <tbody>
                {(pages.items ?? []).map((b) => (
                  <tr key={b.id}>
                    <td className="hint"><Time iso={b.decidedAt} /></td>
                    <td>{b.mapName}</td>
                    <td className="hint">{b.won ? "got played" : "outvoted"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager list={pages} noun="ballot" />
        </>
      )}
    </Panel>
  );
}
