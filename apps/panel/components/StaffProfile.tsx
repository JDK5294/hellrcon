"use client";
/**
 * A staff member's profile — the mirror of a player profile, for people who take moderation actions.
 * Header (who, since when, lifetime action count) + two tabs: Analytics (the rich breakdown: category
 * mix, action profile radar, activity-over-time, top targets/servers) and Actions (their filterable
 * audit trail with clickable targets). Reached by clicking any staff name (StaffLink) or from Activity.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { humanizeIsoInText } from "../lib/time";
import { api, fmt } from "../lib/api";
import { useResource } from "../lib/resource";
import { ActionResult, CopyLink, Nothing, PageHeader, Pager, ScopePicker, SkeletonLines, SkeletonRows, Explanation } from "./ui";
import { useServers } from "../lib/servers";
import { isText, oneOf, useRemembered } from "../lib/remembered";
import { useScope } from "../lib/scope";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { AuditTarget, type AuditEntry as ActivityAuditEntry } from "./Activity";
import { AuditActionButton, AuditDetail, auditRowProps } from "./AuditDetail";
import { StatGrid, StatTile, BreakdownBars, Progression, Radar, RESIDUAL_INDEX, type ProgPoint, type ProgSeries, type RadarSeries } from "./viz";
import { Time } from "./Time";
import { usePagedList } from "../lib/paged";

// Fixed category order === series slot order (never cycled). Mirrors staff-analytics STAFF_CATEGORIES.
// `other` is the residual bucket and stays LAST: it is drawn in neutral ink (RESIDUAL_INDEX), so it
// spends no hue and the seven validated slots cover the seven real categories.
const CATS = ["bans", "kicks", "vips", "messages", "moves", "punishments", "requests", "other"] as const;
type Cat = typeof CATS[number];
/** Slot for a category: its position, except the residual one, which is neutral. */
const catColor = (c: Cat, i: number) => (c === "other" ? RESIDUAL_INDEX : i);

interface Analytics {
  total: number;
  firstAt: string | null;
  lastAt: string | null;
  byAction: Record<string, number>;
  byCategory: Record<Cat, number>;
  topTargets: { id: string | null; name: string; count: number }[];
  topServers: { serverId: string; count: number; name: string }[];
  daily: { date: string; total: number; byCategory: Record<Cat, number> }[];
}
interface Notices {
  postedCount: number; readCount: number; unreadCount: number; ackCount: number;
  readRate: number | null; avgMinutesToSee: number | null; medianMinutesToSee: number | null;
}
interface Profile {
  user: { id: string; username: string; displayName?: string; discordUsername?: string | null; createdAt: string } | null;
  actorName: string;
  analytics: Analytics;
  /** Omitted unless the caller holds analytics.announcements — the API withholds it, not the panel. */
  notices?: Notices;
}
// The Trail's row shape, reused rather than re-declared — both render the same target cell, and
// two copies of the type is how one of them ends up missing a field the other relies on.
type AuditEntry = ActivityAuditEntry;

export default function StaffProfile({ userId }: { userId: string }) {
  const { servers } = useServers();
  // One admin's record, on one server. Their actions each carry the server they were taken on, so
  // "what has this person done HERE" is answerable — it just never was. The server, the tab and
  // the actions' filters are kept per member for the sitting.
  const [scopeId, setScope] = useScope(`staff.${userId}.scope`);
  const [tab, setTab] = useRemembered<"analytics" | "actions">(`staff.${userId}.tab`, "analytics", oneOf(["analytics", "actions"] as const), "session");
  // Through useResource, so clicking from one staff member straight to another cannot leave the
  // first one's request landing second and filling this page under the second one's name.
  const loadProfile = useCallback(
    () => api<Profile>(`/audit/staff/${encodeURIComponent(userId)}${scopeId ? `?serverId=${encodeURIComponent(scopeId)}` : ""}`),
    [userId, scopeId],
  );
  const { data: prof, error } = useResource(loadProfile);

  if (error) return <div className="card"><ActionResult error={error} /></div>;
  if (!prof) return <div className="card"><SkeletonLines lines={4} /></div>;

  const a = prof.analytics;
  const daysActive = a.daily.length;

  return (
    <div>
      <div className="card">
        <PageHeader title={prof.actorName} crumbs={["Admin", "Administration", "Staff activity"]} subtitle="What this admin has done — actions taken, over time." />
        <ScopePicker servers={servers} value={scopeId} onChange={setScope} noun="This admin's actions" />
        <div className="row" style={{ gap: 14, alignItems: "center", marginTop: 4 }}>
          <span className="avatar" style={{ width: 44, height: 44, fontSize: "1.3rem" }}>{prof.actorName.charAt(0).toUpperCase()}</span>
          <div className="muted fs-md">
            {prof.user?.discordUsername && <>@{prof.user.discordUsername} · </>}
            {prof.user ? <>Member since <Time iso={prof.user.createdAt} /></> : <>External / system actor</>}
            {a.lastAt && <> · last active <Time iso={a.lastAt} /></>}
          </div>
          <span style={{ marginLeft: "auto" }}><CopyLink label="Copy profile link" /></span>
        </div>
        <div className="viz-toggles" style={{ marginTop: 12 }}>
          <button className={`viz-toggle${tab === "analytics" ? " active" : ""}`} onClick={() => setTab("analytics")}>Analytics</button>
          <button className={`viz-toggle${tab === "actions" ? " active" : ""}`} onClick={() => setTab("actions")}>Actions</button>
        </div>
      </div>

      {tab === "analytics" ? (
        <StaffAnalyticsTab a={a} daysActive={daysActive} notices={prof.notices} />
      ) : (
        <StaffActionsTab userId={userId} scopeId={scopeId} />
      )}
    </div>
  );
}

function StaffAnalyticsTab({ a, daysActive, notices }: { a: Analytics; daysActive: number; notices?: Notices }) {
  const perDay = daysActive ? (a.total / daysActive) : 0;

  const catData = CATS.map((c, i) => ({ key: c, value: a.byCategory[c] ?? 0, colorIndex: catColor(c, i) }));
  const radarSeries: RadarSeries[] = [{ key: "mix", label: "Action mix", colorIndex: 0, values: Object.fromEntries(CATS.map((c) => [c, a.byCategory[c] ?? 0])) }];
  const radarAxes = CATS.map((c) => ({ key: c, label: c }));

  // Daily activity-over-time, one line per category (fixed slot colour).
  const progSeries: ProgSeries[] = CATS.map((c, i) => ({ key: c, label: c, colorIndex: catColor(c, i) }));
  const progPoints: ProgPoint[] = a.daily.map((d) => ({ x: d.date, values: d.byCategory as Record<string, number> }));

  const topActions = Object.entries(a.byAction).sort((x, y) => y[1] - x[1]).slice(0, 6);

  return (
    <PanelGroup viewId="staff-analytics">
      <Panel id="totals" caps="open" title="Totals">
        <StatGrid>
          <StatTile label="Total actions" value={a.total.toLocaleString()} accent />
          <StatTile label="Days active" value={daysActive} sub={perDay ? `${perDay.toFixed(1)}/day avg` : undefined} />
          <StatTile label="Players touched" value={a.topTargets.length >= 10 ? "10+" : a.topTargets.length} />
          <StatTile label="Servers worked" value={a.topServers.length} />
          <StatTile label="First action" value={a.firstAt ? fmt(a.firstAt).split(",")[0] : "—"} />
        </StatGrid>
      </Panel>

      <Panel id="mix" caps="open" title="Action mix">
        <BreakdownBars data={catData} />
      </Panel>
      <Panel id="profile" caps="open" title="Profile">
        <Radar axes={radarAxes} series={radarSeries} />
      </Panel>

      <Panel id="overtime" caps="open" title="Activity over time">
        <p className="muted mt-0">Actions per day, by category. Toggle a series in the legend; isolate one to see its trend.</p>
        <Progression points={progPoints} series={progSeries} />
      </Panel>

      <Panel id="targets" caps="open" title="Most-acted-on players">
          {a.topTargets.length === 0 ? <Nothing>No actions on players yet.</Nothing> : (
            <div className="recent-list">
              {a.topTargets.map((t) => (
                <div className="recent-card" key={t.id ?? t.name}>
                  <span className="rc-title"><PlayerLink playerId={t.id} name={t.name} /></span>
                  <span className="rc-meta">{t.count} action{t.count === 1 ? "" : "s"}</span>
                </div>
              ))}
            </div>
          )}
      </Panel>
      <Panel id="actions" caps="open" title="Most-used actions">
          {topActions.length === 0 ? <Nothing>No actions yet.</Nothing> : (
            <div className="recent-list">
              {topActions.map(([act, n]) => (
                <div className="recent-card" key={act}>
                  <span className="rc-title"><code>{act}</code></span>
                  <span className="rc-meta">×{n}</span>
                </div>
              ))}
            </div>
          )}
      </Panel>

      <Panel id="notices" caps="analytics.announcements" title="Staff notices">
        <Explanation>How this staff member keeps up with the announcements board — of everything currently posted, what they&apos;ve read, how fast after posting, and what they acknowledged.</Explanation>
        {!notices || notices.postedCount === 0 ? <Nothing>No notices have been posted yet.</Nothing> : (
          <StatGrid>
            <StatTile label="Read" value={`${notices.readCount}/${notices.postedCount}`} sub={notices.readRate !== null ? `${Math.round(notices.readRate * 100)}% of posted notices` : undefined} accent={notices.unreadCount === 0} />
            <StatTile label="Unread" value={notices.unreadCount} />
            <StatTile label="Acknowledged" value={notices.ackCount} />
            <StatTile label="Median time to see" value={fmtMinutes(notices.medianMinutesToSee)} sub={notices.avgMinutesToSee !== null ? `avg ${fmtMinutes(notices.avgMinutesToSee)}` : undefined} />
          </StatGrid>
        )}
      </Panel>
    </PanelGroup>
  );
}

/** Minutes → a human duration ("45m", "3.2h", "2.1d"); null → em dash. */
function fmtMinutes(m: number | null): string {
  if (m === null) return "\u2014";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${(m / 60).toFixed(1)}h`;
  return `${(m / (60 * 24)).toFixed(1)}d`;
}

function StaffActionsTab({ userId, scopeId }: { userId: string; scopeId: string }) {
  const [action, setAction] = useRemembered(`staff.${userId}.action`, "", isText, "session");
  const [from, setFrom] = useRemembered(`staff.${userId}.from`, "", isText, "session");
  const [to, setTo] = useRemembered(`staff.${userId}.to`, "", isText, "session");
  // The action open in its own window: what it changed, setting by setting.
  const [openId, setOpenId] = useState<string | null>(null);

  // Debounced so the date inputs don't fire per keystroke; a new filter resets to page one. The same
  // filters are kept as they are, so settling at mount is not a new filter and the page stays put.
  const [filters, setFilters] = useState({ action, from, to });
  useEffect(() => {
    const t = setTimeout(() => setFilters((cur) => (cur.action === action && cur.from === from && cur.to === to ? cur : { action, from, to })), 200);
    return () => clearTimeout(t);
  }, [action, from, to]);

  const fetchPage = useCallback((offset: number, limit: number, cursor?: string) => {
    const qs = new URLSearchParams({ actor: userId, limit: String(limit), offset: String(offset) });
    if (scopeId) qs.set("serverId", scopeId);
    if (filters.action) qs.set("action", filters.action);
    if (filters.from) qs.set("from", new Date(filters.from).toISOString());
    if (filters.to) qs.set("to", new Date(filters.to).toISOString());
    // An explicit `to` filter still wins — the anchor only ever narrows it.
    if (cursor) qs.set("anchor", cursor);
    return api<{ entries: AuditEntry[]; total?: number; anchor?: string }>(`/audit?${qs.toString()}`)
      .then((r) => ({ items: r.entries, total: r.total ?? null, cursor: r.anchor }));
  }, [userId, filters, scopeId]);
  const trail = usePagedList<AuditEntry>(fetchPage, `staff.${userId}.actions`, scopeId);
  const entries = trail.items;

  // The kinds on the rows loaded, and always the one being filtered by: with nothing to show, or
  // the rows still on their way, it would otherwise drop out of its own dropdown, which then read
  // "All actions" above a list filtered to one kind.
  const actions = useMemo(() => {
    const set = new Set<string>();
    (entries ?? []).forEach((e) => set.add(e.action));
    if (action) set.add(action);
    return [...set].sort();
  }, [entries, action]);

  if (trail.error) return <div className="card"><ActionResult error={trail.error} /></div>;

  return (
    <PanelGroup viewId="staff-actions">
      <Panel id="trail" caps="open" title="Actions">
      <div className="viz-toggles" style={{ alignItems: "center" }}>
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actions.map((act) => <option key={act} value={act}>{act}</option>)}
        </select>
        <label className="muted fs-sm">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="muted fs-sm">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(action || from || to) && <button className="viz-toggle" onClick={() => { setAction(""); setFrom(""); setTo(""); }}>Clear</button>}
      </div>
      {!entries && <SkeletonRows rows={8} cols={4} />}
      {entries && !entries.length && <Nothing>No matching activity.</Nothing>}
      {entries && entries.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} {...auditRowProps(() => setOpenId(e.id))}>
                  <td><Time iso={e.ts} /></td>
                  <td><AuditActionButton action={e.action} onOpen={() => setOpenId(e.id)} /></td>
                  <td><AuditTarget entry={e} /></td>
                  <td style={{ whiteSpace: "normal" }}>{humanizeIsoInText(e.summary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager list={trail} noun="action" />
      {openId && <AuditDetail id={openId} onClose={() => setOpenId(null)} />}
      </Panel>
    </PanelGroup>
  );
}
