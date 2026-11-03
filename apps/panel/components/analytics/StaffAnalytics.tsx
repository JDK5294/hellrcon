"use client";
/**
 * Staff analytics — how moderation work is actually shared out, and when nobody is watching.
 *
 * This is deliberately a TEAM view, not a scoreboard. Ranking admins by raw action count rewards
 * whoever kicks the most, which is the opposite of what a good moderator does; so the page leads
 * with the split and the coverage gaps, and the per-person table carries the mix of work alongside
 * the count rather than a bare ranking.
 *
 * Coverage is the number this page exists for: an hour of the week with no staff action at all in
 * the whole window is an hour your players were on their own.
 *
 * Scope: the staff you HAVE. Departed accounts are left out of every figure here, because a
 * workload split and a coverage grid are for planning the roster — a share held by someone who
 * left makes both read wrong. Their work is not lost; the audit trail keeps it under the name that
 * took it and Administration → Staff activity is where you read it back.
 *
 * Reads GET /analytics/staff?days. Separate capability from the audit trail — this shows shape,
 * the trail shows individual actions.
 */
import { useCallback, useState } from "react";
import { zoneLabel } from "../../lib/time";
import { api } from "../../lib/api";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, GoTo, ScopePicker, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { useServers } from "../../lib/servers";
import { useRememberedSet } from "../../lib/remembered";
import { useScope } from "../../lib/scope";
import { StaffLink } from "../StaffLink";
import { Time } from "../Time";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, Heatmap, SplitBar, Progression, BreakdownBars } from "../viz";
import { PlayerLink } from "../PlayerLink";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, counted, dur, hourLabel, num, pct, ReadPending } from "./shared";

interface Member {
  userId: string | null;
  name: string;
  actions: number;
  share: number;
  lastAt: string | null;
  byCategory: Record<string, number>;
  roleIds?: string[];
}
interface RoleOpt { id: string; name: string }
interface Payload {
  window: { from: string; to: string };
  totalActions: number;
  activeStaff: number;
  members: Member[];
  totalStaff?: number;
  /** The whole team regardless of hiding, so the "measured" picker can list who is hidden. */
  allMembers?: { userId: string; name: string }[];
  roles?: RoleOpt[];
  weekHour: number[][];
  byHour: number[];
  byAction: { label: string; value: number }[];
  timeline: { date: string; actions: number }[];
  uncoveredHours: number;
  busiestShare: number | null;
  response: {
    requests: number;
    answered: number;
    unanswered: number;
    answeredRate: number | null;
    medianSec: number | null;
    p90Sec: number | null;
    byHour: number[];
    weekHour: number[][];
    medianByHour: (number | null)[];
    slowest: AdminRequest[];
    recent: AdminRequest[];
  };
}

interface AdminRequest {
  ts: string;
  serverId: string;
  playerName: string | null;
  playerId: string | null;
  message: string;
  responseSec: number | null;
  respondedBy: string | null;
  respondedAction: string | null;
}

/** Fixed order so a category keeps its colour as people's mixes change. */
/** Mirrors TEAM_CATEGORIES in the API (analytics.ts). Sixteen on purpose — separation was chosen
 *  over hue uniqueness (product call): these render as LABELLED rows, so the label carries
 *  identity and the seven validated hues simply cycle. Nothing unvalidated is drawn. */
const CATEGORIES = [
  { key: "messages", label: "Messages" },
  { key: "kicks", label: "Kicks" },
  { key: "punishes", label: "Punishes" },
  { key: "switches", label: "Team switches" },
  { key: "tempbans", label: "Temp bans" },
  { key: "permabans", label: "Perma bans" },
  { key: "unbans", label: "Unbans" },
  { key: "banrecord", label: "Ban record" },
  { key: "vip", label: "VIP" },
  { key: "records", label: "Notes & flags" },
  { key: "maprotation", label: "Map rotation" },
  { key: "mapvotes", label: "Map votes" },
  { key: "economy", label: "Economy & payouts" },
  { key: "settings", label: "Settings & automation" },
  { key: "approvals", label: "Approvals & requests" },
  { key: "other", label: "Other" },
];

function readHidden(key: string): Set<string> {
  try { return new Set((localStorage.getItem(key) ?? "").split(",").filter(Boolean)); } catch { return new Set(); }
}

export default function StaffAnalytics() {
  const { servers } = useServers();
  const [range, setRange] = useAnalyticsRange("staff");
  // Staff actions carry the server they happened on, so "who is moderating THIS server" is a real
  // question — and this page could only ever answer "who is busy across the community".
  const [scopeId, setScope] = useScope("analytics.staff.scope");
  /*
   * The viewer's exclusions — people and kinds of work left out of EVERY figure on the page.
   * Server-side on purpose: the heatmaps, shares and response pairing are all built from the raw
   * rows, so a client-side hide could only ever fake the member table. Persisted per viewer:
   * "measure the team without my settings churn" is a standing preference, not a one-off.
   */
  const [hiddenUsers, setHiddenUsers] = useState<Set<string>>(() => readHidden("analytics.staff.hideUsers"));
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(() => readHidden("analytics.staff.hideCats"));
  const hu = [...hiddenUsers].sort().join(",");
  const hc = [...hiddenCats].sort().join(",");
  const load = useCallback(
    () => api<Payload>(`/analytics/staff?${rangeQuery(range)}${scopeId ? `&serverId=${encodeURIComponent(scopeId)}` : ""}${hu ? `&hideUsers=${encodeURIComponent(hu)}` : ""}${hc ? `&hideCategories=${encodeURIComponent(hc)}` : ""}`, { timeoutMs: rangeTimeoutMs(range) }),
    [range, scopeId, hu, hc],
  );
  const { data, error, reload } = useResource(load);
  const [measureOpen, setMeasureOpen] = useState(false);
  const toggleHidden = (which: "users" | "cats", id: string) => {
    const [get, set, key] = which === "users"
      ? [hiddenUsers, setHiddenUsers, "analytics.staff.hideUsers"] as const
      : [hiddenCats, setHiddenCats, "analytics.staff.hideCats"] as const;
    const next = new Set(get);
    if (next.has(id)) next.delete(id); else next.add(id);
    set(next);
    try { localStorage.setItem(key, [...next].join(",")); } catch { /* preference only */ }
  };

  // Narrow the team to holders of the picked roles — the same control the Staff activity page
  // has, because "how is the moderator team doing" is a different question from "how is the
  // whole staff list doing".
  const [roleFilter, toggleRole, clearRoles] = useRememberedSet("analytics.staff.roles");
  const [rolesOpen, setRolesOpen] = useState(false);
  const roles = data?.roles ?? [];
  const shown = roleFilter.size
    ? (data?.members ?? []).filter((m) => (m.roleIds ?? []).some((id) => roleFilter.has(id)))
    : (data?.members ?? []);

  const sort = useSortable<Member>({
    name: (m) => m.name,
    actions: (m) => m.actions,
    share: (m) => m.share,
    last: (m) => m.lastAt ?? "",
  }, "actions", "desc", "analytics.staff.members");

  // `data` can arrive without the field; subtracting undefined is NaN, not zero.
  const covered = Number.isFinite(data?.uncoveredHours as number) ? 168 - (data!.uncoveredHours as number) : null;

  return (
    <PanelGroup viewId="analytics.staff">
      <Panel id="overview" caps="open" title="The team" subtitle="staff actions across the window">
        <ScopePicker servers={servers} value={scopeId} onChange={setScope} noun="Staff activity" />
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `${num(data.totalActions)} actions by ${num(data.activeStaff)} of ${num(data.totalStaff ?? data.activeStaff)} staff` : null}
        />
        <ActionResult error={error} />
        {/* What gets MEASURED. Pressed = left out of every figure on this page — the member
            table, the split, both hour grids, the timeline and the response pairing — so a
            settings-heavy profile can stop skewing the moderation picture. A lens, not a record:
            the audit trail keeps everything. */}
        <div className="control-row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          <button className={`ghost mini${hiddenUsers.size || hiddenCats.size ? " pressed" : ""}`}
            onClick={() => setMeasureOpen((o) => !o)} aria-expanded={measureOpen}>
            Measured{hiddenUsers.size + hiddenCats.size ? ` (hiding ${hiddenUsers.size + hiddenCats.size})` : ""} {measureOpen ? "▴" : "▾"}
          </button>
          {measureOpen && (
            <>
              <div className="seg" role="group" aria-label="Hide people from the figures">
                {(data?.allMembers ?? []).map((m) => (
                  <button key={m.userId} className={`seg-btn ${hiddenUsers.has(m.userId) ? "active" : ""}`}
                    aria-pressed={hiddenUsers.has(m.userId)} title={hiddenUsers.has(m.userId) ? "Hidden from every figure — press to include again" : "Press to leave out of every figure"}
                    onClick={() => toggleHidden("users", m.userId)}>{m.name}</button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Hide kinds of work from the figures">
                {CATEGORIES.map((c) => (
                  <button key={c.key} className={`seg-btn ${hiddenCats.has(c.key) ? "active" : ""}`}
                    aria-pressed={hiddenCats.has(c.key)} title={hiddenCats.has(c.key) ? "Hidden from every figure — press to include again" : "Press to leave out of every figure"}
                    onClick={() => toggleHidden("cats", c.key)}>{c.label}</button>
                ))}
              </div>
              <span className="hint">Pressed = left out of every figure on this page. The audit trail is never filtered.</span>
            </>
          )}
        </div>
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          <StatGrid>
            <StatTile label="Actions" value={num(data?.totalActions)} sub="everything audited in the window" accent />
            <StatTile label="Active staff" value={num(data?.activeStaff)}
              sub={data?.totalStaff ? `of ${num(data.totalStaff)} on the team — the rest did nothing in this window` : "people who did at least one thing"} />
            <StatTile
              label="Busiest person's share"
              value={pct(data?.busiestShare)}
              sub={data && data.busiestShare != null && data.busiestShare > 0.5 ? "one person is carrying this" : "of all actions"}
            />
            <StatTile
              label="Hours covered"
              value={`${num(covered)}/168`}
              sub={`${counted(data?.uncoveredHours, "hour")} of the week with nothing at all`}
            />
          </StatGrid>
        )}
        {data && data.totalActions > 0 && (
          <Explanation>
            Action count is a measure of workload, not of quality — the best moderation often leaves the
            fewest records. Read it beside the coverage grid, not as a ranking.
          </Explanation>
        )}
      </Panel>

      <Panel id="response" caps="open" title="How long players wait" subtitle="from an admin call to a staff action">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          (data?.response?.requests ?? 0) === 0
            ? (
              <>
                <p className="nothing">No admin calls in this window.</p>
                <Explanation>
                  A call is a chat line beginning with your server&rsquo;s admin trigger — the same one the
                  Discord admin-ping alert watches, set under <GoTo view="discord">Discord</GoTo>. If nobody
                  has been told the trigger exists, nobody uses it, and this panel stays empty.
                </Explanation>
              </>
            )
            : (
              <>
                <StatGrid>
                  <StatTile label="Median wait" value={dur(data?.response?.medianSec)} sub={`90th percentile ${dur(data?.response?.p90Sec)}`} accent />
                  <StatTile label="Admin calls" value={num(data?.response?.requests)} sub={`${num(data?.response?.answered)} got a response`} />
                  <StatTile
                    label="Answered"
                    value={pct(data?.response?.answeredRate)}
                    sub={`${num(data?.response?.unanswered)} with nothing following within 30 minutes`}
                  />
                </StatGrid>
                <Explanation>
                  This is a best-effort pairing, not proof: it matches each call to the next staff action
                  on that same server within 30 minutes, and one action can only answer one call. It cannot
                  know a given kick was caused by a given call — but a median that climbs, or a large
                  unanswered share, is real either way.
                </Explanation>
                <h4 className="an-h">Calls by hour of day ({zoneLabel()})</h4>
                <Bars
                  data={(data?.response?.byHour ?? []).map((v, h) => ({
                    label: hourLabel(h),
                    value: v,
                    hint: data?.response?.medianByHour?.[h] != null ? `median wait ${dur(data.response.medianByHour[h])}` : "no answered calls this hour",
                  }))}
                  colorIndex={3}
                  empty="No admin calls in this window."
                />
                <h4 className="an-h">Median wait by hour</h4>
                <Bars
                  data={(data?.response?.medianByHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v == null ? 0 : Math.round(v / 60) }))}
                  colorIndex={4}
                  format={(n) => `${n}m`}
                  highlightMax={false}
                  empty="No answered calls in this window."
                />
                <Explanation>
                  Read the two together: an hour with many calls and a long median is where cover is
                  actually thin, which is not always the hour with the fewest staff actions.
                </Explanation>
              </>
            )
        )}
      </Panel>

      <Panel id="slowest" caps="open" title="Longest waits" subtitle="the calls worth reading back">
        {!data ? <ReadPending error={error}><SkeletonRows rows={5} cols={4} /></ReadPending> : (
          (data?.response?.slowest?.length ?? 0) === 0
            ? <p className="nothing">No answered admin calls in this window.</p>
            : (
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <th>When</th>
                    <th>Player</th>
                    <th>What they said</th>
                    <th className="num">Waited</th>
                    <th>Answered by</th>
                  </tr></thead>
                  <tbody>
                    {(data?.response?.slowest ?? []).map((r, i) => (
                      <tr key={`${r.ts}-${i}`}>
                        <td><Time iso={r.ts} /></td>
                        <td><PlayerLink playerId={r.playerId} name={r.playerName ?? "—"} /></td>
                        <td className="wrap">{r.message}</td>
                        <td className="num">{dur(r.responseSec)}</td>
                        <td>{r.respondedBy ?? "—"}<span className="muted fs-xs"> {r.respondedAction ?? ""}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </Panel>

      <Panel id="split" caps="open" title="How the work is split" subtitle="share of all actions, per person">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <SplitBar
            slices={(data?.members ?? []).filter((m) => m.actions > 0).slice(0, 7).map((m, i) => ({
              key: m.userId ?? m.name,
              label: m.name,
              value: m.actions,
              colorIndex: i,
            }))}
            empty="No staff actions in this window."
          />
        )}
      </Panel>

      <Panel id="coverage" caps="open" title="Cover across the week" subtitle="when staff are actually doing things">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <Heatmap grid={data?.weekHour ?? []} label="actions" empty="No staff actions in this window yet." />
            <Explanation>
              Empty cells are hours of the week where, across the whole window, no staff member did
              anything at all. A quiet hour is not automatically a problem — a quiet hour that is also
              one of your busiest player hours is. Compare it against the same grid on the{" "}
              <GoTo view="analytics" tab="server">Server</GoTo> page.
            </Explanation>
            <h4 className="an-h">By hour of day ({zoneLabel()})</h4>
            <Bars
              data={(data?.byHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v }))}
              colorIndex={2}
              empty="No staff actions in this window."
            />
          </>
        )}
      </Panel>

      <Panel id="people" caps="open" title="Per person"
        subtitle={data?.members ? `${roleFilter.size ? `${shown.length} of ` : ""}${data.members.length} on the team` : "workload and the mix of it"}>
        {roles.length > 0 && (
          <div className="control-row" style={{ marginBottom: 8 }}>
            <button className={`ghost mini${roleFilter.size ? " pressed" : ""}`} onClick={() => setRolesOpen((o) => !o)} aria-expanded={rolesOpen}>
              Roles{roleFilter.size ? ` (${roleFilter.size})` : ""} {rolesOpen ? "▴" : "▾"}
            </button>
            {rolesOpen && (
              <div className="seg" role="group" aria-label="Filter by role">
                {roles.map((r) => (
                  <button key={r.id} className={`seg-btn ${roleFilter.has(r.id) ? "active" : ""}`}
                    aria-pressed={roleFilter.has(r.id)} onClick={() => toggleRole(r.id)}>{r.name.trim() || "Unnamed role"}</button>
                ))}
              </div>
            )}
            {rolesOpen && roleFilter.size > 0 && <button className="ghost mini" onClick={clearRoles}>Clear</button>}
          </div>
        )}
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={5} /></ReadPending> : (
          shown.length === 0
            ? <p className="nothing">{roleFilter.size ? "Nobody holds the selected role(s)." : "No staff accounts yet."}</p>
            : (
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <SortTh s={sort} k="name">Staff member</SortTh>
                    <SortTh s={sort} k="actions" numeric>Actions</SortTh>
                    <SortTh s={sort} k="share" numeric>Share</SortTh>
                    <th>Mix of work</th>
                    <SortTh s={sort} k="last">Last action</SortTh>
                  </tr></thead>
                  <tbody>
                    {sort.sorted(shown).map((m) => (
                      <tr key={m.userId ?? m.name}>
                        <td>{m.userId ? <StaffLink userId={m.userId} name={m.name} /> : m.name}</td>
                        <td className="num">{num(m.actions)}</td>
                        <td className="num">{m.actions ? pct(m.share) : "—"}</td>
                        <td className="an-mix">
                          <BreakdownBars
                            /* The union, not just the known list: byCategory comes from the API,
                               and during an upgrade the two sides briefly disagree about the key
                               set (the static panel swaps on disk the moment it is rebuilt; the
                               API keeps its old code until the process restarts). Dropping
                               unknown keys made the mix visibly not sum to the Actions column —
                               a page that fails to add up reads as broken arithmetic, when the
                               truth was a hidden bucket. Unknown keys render under their raw key
                               name until the API catches up. */
                            data={[
                              ...CATEGORIES.map((c, i) => ({ key: c.key, label: c.label, value: m.byCategory[c.key] ?? 0, colorIndex: i % 7 })),
                              ...Object.keys(m.byCategory)
                                .filter((k) => !CATEGORIES.some((c) => c.key === k))
                                .map((k, j) => ({ key: k, label: k, value: m.byCategory[k] ?? 0, colorIndex: (CATEGORIES.length + j) % 7 })),
                            ]}
                            empty="—"
                          />
                        </td>
                        <td>{m.lastAt ? <Time iso={m.lastAt} /> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
        <Explanation>
          This page counts the staff you have now. Work done by people who have since left the team
          is kept in full, under the name that did it — read it in{" "}
          <GoTo view="admin" tab="activity">Staff activity</GoTo>.
        </Explanation>
      </Panel>

      <Panel id="actions" caps="open" title="What gets done" subtitle="the actions themselves, most common first">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <BreakdownBars
            data={(data?.byAction ?? []).slice(0, 20).map((b, i) => ({ key: b.label, label: b.label, value: b.value, colorIndex: i }))}
            empty="No staff actions in this window."
          />
        )}
        <p className="muted fs-xs">
          Individual entries, with who and why, are in the audit trail:{" "}
          <GoTo view="admin" tab="activity">Staff activity</GoTo>
        </p>
      </Panel>

      <Panel id="timeline" caps="open" title="Workload over time" subtitle="actions per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          (data?.timeline?.length ?? 0) === 0
            ? <p className="nothing">No days with staff actions in this window.</p>
            : (
              <Progression
                points={(data?.timeline ?? []).map((t) => ({ x: t.date, label: t.date, values: { actions: t.actions } }))}
                series={[{ key: "actions", label: "Staff actions", colorIndex: 0 }]}
              />
            )
        )}
      </Panel>
    </PanelGroup>
  );
}
