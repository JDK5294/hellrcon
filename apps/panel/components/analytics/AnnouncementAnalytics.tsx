"use client";
/**
 * Announcement analytics — did the team actually read it.
 *
 * This is the only analytics page whose subject is the staff themselves rather than the game, and
 * it answers a question a noticeboard cannot: posting is not communicating. A notice with a 40%
 * read rate three days on is a notice most of your team has not seen, and "I posted it" is not a
 * defence anyone should be able to offer.
 *
 * It sits here rather than on the board because it is a measurement, not part of writing a notice —
 * the board links across. Its own capability (`analytics.announcements`), like every other page in
 * this section.
 *
 * Reads GET /community/announcements/analytics.
 */
import { useCallback } from "react";
import { api } from "../../lib/api";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, GoTo, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { Time } from "../Time";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, SplitBar } from "../viz";
import { minutes, num, pct, ReadPending } from "./shared";

interface Row {
  id: string; title: string; published: boolean; publishedAt: string | null;
  readCount: number; ackCount: number; staffCount: number;
  avgMinutesToSee: number | null; medianMinutesToSee: number | null;
}
interface Payload {
  staffCount: number;
  postedCount: number;
  overallReadRate: number | null;
  overallAvgMinutesToSee: number | null;
  notices: Row[];
}


export default function AnnouncementAnalytics() {
  const load = useCallback(() => api<Payload>("/community/announcements/analytics"), []);
  const { data, error, reload } = useResource(load);

  const posted = (data?.notices ?? []).filter((n) => n.published);
  const sort = useSortable<Row>({
    title: (n) => n.title,
    posted: (n) => n.publishedAt ?? "",
    seen: (n) => (n.staffCount ? n.readCount / n.staffCount : -1),
    acked: (n) => (n.staffCount ? n.ackCount / n.staffCount : -1),
    avg: (n) => n.avgMinutesToSee ?? -1,
  }, "posted", "desc", "analytics.announcements");

  // The notice the most people still haven't opened — the one worth chasing, and the reason this
  // page exists at all.
  const leastRead = [...posted]
    .filter((n) => n.staffCount > 0)
    .sort((a, b) => (a.readCount / a.staffCount) - (b.readCount / b.staffCount))[0];
  const totalReads = posted.reduce((n, x) => n + x.readCount, 0);
  const totalAcks = posted.reduce((n, x) => n + x.ackCount, 0);
  const totalPossible = posted.reduce((n, x) => n + x.staffCount, 0);

  return (
    <PanelGroup viewId="analytics.announcements">
      <Panel
        id="overview"
        caps="open"
        title="Reach"
        subtitle="how much of the team a notice actually gets to"
        actions={<button type="button" className="ghost mini" onClick={reload}>Refresh</button>}
      >
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          data && data.postedCount === 0
            ? (
              <>
                <p className="nothing">No notices have been posted yet.</p>
                <p className="muted fs-xs">
                  Post one on the board and its reach shows up here:{" "}
                  <GoTo view="community">Announcements</GoTo>
                </p>
              </>
            )
            : (
              <>
                <StatGrid>
                  <StatTile label="Average read rate" value={pct(data?.overallReadRate)} sub={`across ${num(data?.postedCount)} posted notices`} accent />
                  <StatTile label="Staff on the roster" value={num(data?.staffCount)} sub="the denominator for every rate here" />
                  <StatTile label="Average time to see" value={minutes(data?.overallAvgMinutesToSee)} sub="from posting to first view" />
                  <StatTile
                    label="Least-read notice"
                    value={leastRead ? pct(leastRead.staffCount ? leastRead.readCount / leastRead.staffCount : null) : "—"}
                    sub={leastRead ? leastRead.title : "nothing posted yet"}
                  />
                </StatGrid>
                <SplitBar
                  slices={[
                    { key: "ack", label: "Acknowledged", value: totalAcks, colorIndex: 0 },
                    { key: "seen", label: "Seen, not acknowledged", value: Math.max(0, totalReads - totalAcks), colorIndex: 1 },
                    { key: "unseen", label: "Never opened", value: Math.max(0, totalPossible - totalReads), colorIndex: 2 },
                  ]}
                  empty="No posted notices yet."
                />
                <Explanation>
                  A notice counts as <strong>seen</strong> the first time the board shows it to someone —
                  their first visit after it was posted, never overwritten, so time-to-see stays honest.
                  <strong> Acknowledged</strong> is the explicit ✓ click, which only the notices that
                  really must be read tend to get.
                </Explanation>
              </>
            )
        )}
      </Panel>

      {data && posted.length > 0 && (
        <Panel id="pernotice" caps="open" title="Per notice" subtitle="who saw what, and how long it took">
          {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={6} /></ReadPending> : (
            <>
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <SortTh s={sort} k="title">Notice</SortTh>
                    <SortTh s={sort} k="posted">Posted</SortTh>
                    <SortTh s={sort} k="seen" numeric>Seen</SortTh>
                    <SortTh s={sort} k="acked" numeric>Acknowledged</SortTh>
                    <SortTh s={sort} k="avg" numeric>Avg time to see</SortTh>
                    <th className="num">Median</th>
                  </tr></thead>
                  <tbody>
                    {sort.sorted(posted).map((n) => (
                      <tr key={n.id}>
                        <td className="wrap">{n.title}</td>
                        <td>{n.publishedAt ? <Time iso={n.publishedAt} /> : "—"}</td>
                        <td className="num">
                          <span className={`badge ${n.readCount >= n.staffCount ? "active" : "observe"}`}>{n.readCount}/{n.staffCount}</span>
                        </td>
                        <td className="num">{n.ackCount}/{n.staffCount}</td>
                        <td className="num">{minutes(n.avgMinutesToSee)}</td>
                        <td className="num">{minutes(n.medianMinutesToSee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4 className="an-h">Read rate per notice</h4>
              <Bars
                data={posted.map((n) => ({
                  label: n.title.length > 18 ? `${n.title.slice(0, 17)}…` : n.title,
                  value: n.staffCount ? Math.round((n.readCount / n.staffCount) * 100) : 0,
                  hint: `${n.readCount} of ${n.staffCount} staff · ${n.title}`,
                }))}
                colorIndex={0}
                format={(v) => `${v}%`}
                highlightMax={false}
                empty="No posted notices yet."
              />
              <p className="muted fs-xs">
                Who exactly has and hasn&apos;t opened a given notice is on the notice itself:{" "}
                <GoTo view="community">Announcements</GoTo>
              </p>
            </>
          )}
        </Panel>
      )}
    </PanelGroup>
  );
}
